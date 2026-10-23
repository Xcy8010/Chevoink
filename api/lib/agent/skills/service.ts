import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

import type {
  AgentSkillListItem,
  AgentSkillDetail,
  AgentSkillRunSummary,
  AgentSkillTestResult,
  CreateNovelSkillRequest,
  CreateNovelSkillVersionRequest,
  ImportThirdPartySkillRequest,
  NovelSkillsPayload,
  TestNovelSkillRequest,
  UpdateNovelSkillRequest,
} from '../../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { customSkillToRuntime, buildCustomSkillArtifacts } from './custom.js'
import { frozenV360BuiltinCatalog, frozenV350BuiltinCatalog, historicalBuiltinCatalog, routeSkills, skillCatalog, SKILL_ROUTER_VERSION, type AgentSkill } from './index.js'
import { getSkillUsage } from './receipts.js'

const BUILTIN_SOURCE = 'builtin'
const NOVEL_SCOPE = 'novel'

function manifestFor(skill: AgentSkill): Prisma.InputJsonObject {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    owner: skill.owner,
    license: skill.license,
    ...(skill.attribution ? { attribution: skill.attribution } : {}),
    status: skill.status,
    intents: skill.intents,
    modes: skill.modes,
    phases: skill.phases,
    triggers: skill.triggers.map((trigger) => ({
      pattern: trigger.pattern.source,
      reasonCode: trigger.reasonCode,
      weight: trigger.weight,
    })),
    negativeTriggers: skill.negativeTriggers.map((pattern) => pattern.source),
    tokenBudget: skill.tokenBudget,
    priority: skill.priority,
    conflicts: skill.conflicts,
    composesWith: skill.composesWith,
  }
}

function instructionsFor(skill: AgentSkill): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(skill.resources).filter((entry) => Boolean(entry[1]))) as Prisma.InputJsonObject
}

function contentHash(skill: AgentSkill): string {
  return createHash('sha256')
    .update(JSON.stringify({ manifest: manifestFor(skill), instructions: instructionsFor(skill) }))
    .digest('hex')
}

/** 内置目录是代码资产；同步只做幂等 upsert，版本内容一旦存在不被覆盖。 */
export async function syncBuiltinSkillCatalog(tx?: Prisma.TransactionClient): Promise<void> {
  const client = tx ?? prisma
  const definitionOperations = skillCatalog.map((skill) => client.agentSkillDefinition.upsert({
    where: { id: skill.id },
    create: {
      id: skill.id,
      ownerUserId: null,
      name: skill.name,
      description: skill.description,
      source: BUILTIN_SOURCE,
      visibility: 'builtin',
      license: skill.license,
      status: skill.status,
      defaultVersion: skill.version,
    },
    update: {
      name: skill.name,
      description: skill.description,
      license: skill.license,
      status: skill.status,
      defaultVersion: skill.version,
    },
  }))
  // Fresh admission already owns a transaction/connection. Keep its writes and
  // rollback there rather than waiting on a nested global pool connection.
  if (tx) { for (const operation of definitionOperations) await operation }
  else await prisma.$transaction(definitionOperations)

  const versionOperations = [...historicalBuiltinCatalog, ...frozenV350BuiltinCatalog, ...frozenV360BuiltinCatalog, ...skillCatalog].map((skill) => client.agentSkillVersion.upsert({
    where: { skillId_version: { skillId: skill.id, version: skill.version } },
    create: {
      skillId: skill.id,
      version: skill.version,
      instructions: instructionsFor(skill),
      manifest: manifestFor(skill),
      contentHash: contentHash(skill),
      status: 'active',
    },
    // 不可变版本：同一 skillId@version 已存在时禁止静默改写内容。
    update: {},
  }))
  if (tx) { for (const operation of versionOperations) await operation }
  else await prisma.$transaction(versionOperations)
}

async function assertOwnedNovel(userId: string, novelId: string, transaction?: Prisma.TransactionClient): Promise<void> {
  const db = transaction ?? prisma
  const novel = await db.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
}

async function ensureNovelInstallations(userId: string, novelId: string, transaction?: Prisma.TransactionClient): Promise<void> {
  const db = transaction ?? prisma
  await syncBuiltinSkillCatalog(transaction)
  await db.agentSkillInstallation.createMany({
    data: skillCatalog.map((skill) => ({
      skillId: skill.id,
      userId,
      scope: NOVEL_SCOPE,
      scopeId: novelId,
      enabled: true,
      lockedVersion: skill.version,
      priority: skill.priority,
    })),
    skipDuplicates: true,
  })
}

function readSelected(value: Prisma.JsonValue): Array<{ id: string; name: string; version: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.name === 'string' && typeof record.version === 'string'
      ? [{ id: record.id, name: record.name, version: record.version }]
      : []
  })
}

function readStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export async function listNovelSkills(userId: string, novelId: string, transaction?: Prisma.TransactionClient): Promise<NovelSkillsPayload> {
  const db = transaction ?? prisma
  await assertOwnedNovel(userId, novelId, transaction)
  await ensureNovelInstallations(userId, novelId, transaction)

  const [definitions, installations, runs, usageBySkill] = await Promise.all([
    db.agentSkillDefinition.findMany({
      where: { OR: [{ source: BUILTIN_SOURCE, status: 'active' }, { ownerUserId: userId }, { installations: { some: { userId, scope: NOVEL_SCOPE, scopeId: novelId } } }] },
      include: {
        versions: { orderBy: { createdAt: 'desc' } },
        audits: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: [{ source: 'asc' }, { name: 'asc' }],
    }),
    db.agentSkillInstallation.findMany({
      where: { userId, scope: NOVEL_SCOPE, scopeId: novelId },
    }),
    db.agentSkillRun.findMany({
      where: { userId, novelId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    getSkillUsage(userId, novelId, transaction),
  ])

  const installationBySkill = new Map(installations.map((installation) => [installation.skillId, installation]))
  const runtimeById = new Map(skillCatalog.map((skill) => [skill.id, skill]))

  const items: AgentSkillListItem[] = definitions.map((definition) => {
    const installation = installationBySkill.get(definition.id)
    const runtime = runtimeById.get(definition.id)
    // Built-ins follow the current code-asset policy for new tasks. A saved
    // historical lock remains in storage and frozen runs resolve it separately.
    const activeVersion = runtime?.version ?? installation?.lockedVersion ?? definition.defaultVersion
    const customVersion = definition.versions.find((version) => version.version === activeVersion)
    const customManifest = customVersion?.manifest && typeof customVersion.manifest === 'object' && !Array.isArray(customVersion.manifest)
      ? customVersion.manifest as Record<string, unknown>
      : null
    const usage = usageBySkill.get(definition.id)
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      source: definition.source as AgentSkillListItem['source'],
      license: definition.license,
      status: definition.status as AgentSkillListItem['status'],
      defaultVersion: definition.defaultVersion,
      activeVersion,
      enabled: installation?.enabled ?? definition.source === BUILTIN_SOURCE,
      phases: runtime?.phases ?? (Array.isArray(customManifest?.phases) ? customManifest.phases.filter((value): value is string => typeof value === 'string') : []),
      triggerLabels: runtime?.triggers.map((trigger) => trigger.reasonCode) ?? (Array.isArray(customManifest?.triggerPhrases) ? customManifest.triggerPhrases.filter((value): value is string => typeof value === 'string') : []),
      negativeTriggerLabels: runtime?.negativeTriggers.map((pattern) => pattern.source) ?? (Array.isArray(customManifest?.negativeTriggerPhrases) ? customManifest.negativeTriggerPhrases.filter((value): value is string => typeof value === 'string') : []),
      tokenBudget: runtime?.tokenBudget ?? (typeof customManifest?.tokenBudget === 'number' ? customManifest.tokenBudget : 0),
      priority: installation?.priority ?? runtime?.priority ?? (typeof customManifest?.priority === 'number' ? customManifest.priority : 0),
      lastUsedAt: usage?.lastUsedAt.toISOString() ?? null,
      usageCount: usage?.count ?? 0,
      versions: definition.versions.map((version) => ({
        version: version.version,
        status: version.status as AgentSkillListItem['status'],
        contentHash: version.contentHash,
        createdAt: version.createdAt.toISOString(),
      })),
      canEdit: definition.ownerUserId === userId,
      latestAudit: definition.audits[0]
        ? {
            id: definition.audits[0].id,
            version: definition.audits[0].version,
            status: definition.audits[0].status as 'passed' | 'failed',
            findings: readStrings(definition.audits[0].findings),
            createdAt: definition.audits[0].createdAt.toISOString(),
          }
        : null,
    }
  })

  const recentRuns: AgentSkillRunSummary[] = runs.slice(0, 8).map((run) => ({
    runId: run.runId,
    phase: run.phase,
    selected: readSelected(run.selected),
    reasonCodes: readStrings(run.reasonCodes),
    confidence: run.confidence,
    estimatedTokens: run.estimatedTokens,
    createdAt: run.createdAt.toISOString(),
  }))

  return {
    items,
    recentRuns,
    enabledCount: items.filter((item) => item.enabled).length,
    totalCount: items.length,
  }
}

export async function getNovelSkillDetail(
  userId: string,
  novelId: string,
  skillId: string,
  requestedVersion?: string,
): Promise<AgentSkillDetail> {
  await assertOwnedNovel(userId, novelId)
  const payload = await listNovelSkills(userId, novelId)
  const item = payload.items.find((skill) => skill.id === skillId)
  if (!item) throw new DataAccessError(404, 'SKILL_NOT_FOUND', '技能不存在或无权访问。')
  const versionName = requestedVersion ?? item.activeVersion
  const definition = await prisma.agentSkillDefinition.findFirst({
    where: { id: skillId, OR: [{ source: BUILTIN_SOURCE }, { ownerUserId: userId }, { installations: { some: { userId, scope: NOVEL_SCOPE, scopeId: novelId } } }] },
    include: {
      versions: { where: { version: versionName }, take: 1 },
      audits: { where: { version: versionName }, orderBy: { createdAt: 'desc' }, take: 10 },
      evals: { where: { version: versionName, userId, novelId }, orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  const version = definition?.versions[0]
  if (!definition || !version) throw new DataAccessError(404, 'SKILL_VERSION_NOT_FOUND', '技能版本不存在。')
  const manifest = version.manifest && typeof version.manifest === 'object' && !Array.isArray(version.manifest)
    ? version.manifest as Record<string, unknown>
    : {}
  const instructions = version.instructions && typeof version.instructions === 'object' && !Array.isArray(version.instructions)
    ? version.instructions as Record<string, string>
    : {}
  return {
    item,
    version: version.version,
    manifest,
    instructions,
    audits: definition.audits.map((audit) => ({
      id: audit.id,
      version: audit.version,
      status: audit.status as 'passed' | 'failed',
      findings: readStrings(audit.findings),
      createdAt: audit.createdAt.toISOString(),
    })),
    recentEvals: definition.evals.flatMap((evaluation) => {
      if (!evaluation.result || typeof evaluation.result !== 'object' || Array.isArray(evaluation.result)) return []
      const result = evaluation.result as unknown as AgentSkillTestResult
      return [{ ...result, id: evaluation.id, createdAt: evaluation.createdAt.toISOString() }]
    }),
  }
}

export async function updateNovelSkill(
  userId: string,
  novelId: string,
  skillId: string,
  patch: UpdateNovelSkillRequest, transaction?: Prisma.TransactionClient
): Promise<NovelSkillsPayload> {
  const db = transaction ?? prisma
  await assertOwnedNovel(userId, novelId, transaction)
  await ensureNovelInstallations(userId, novelId, transaction)
  const definition = await db.agentSkillDefinition.findFirst({
    where: { id: skillId, status: 'active', OR: [{ source: BUILTIN_SOURCE }, { ownerUserId: userId }, { installations: { some: { userId, scope: NOVEL_SCOPE, scopeId: novelId } } }] },
    select: { id: true, defaultVersion: true },
  })
  if (!definition) throw new DataAccessError(404, 'SKILL_NOT_FOUND', '技能不存在或无权访问。')

  const lockedVersion = patch.lockedVersion === undefined ? undefined : patch.lockedVersion ?? definition.defaultVersion
  if (lockedVersion) {
    const version = await db.agentSkillVersion.findUnique({
      where: { skillId_version: { skillId, version: lockedVersion } },
      select: { id: true, status: true },
    })
    if (!version || version.status !== 'active') throw new DataAccessError(409, 'SKILL_VERSION_NOT_FOUND', '指定的已发布技能版本不存在，无法回滚。')
  }

  await db.agentSkillInstallation.update({
    where: { skillId_userId_scope_scopeId: { skillId, userId, scope: NOVEL_SCOPE, scopeId: novelId } },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(lockedVersion !== undefined ? { lockedVersion } : {}),
    },
  })
  return listNovelSkills(userId, novelId, transaction)
}

async function findOwnedSkill(userId: string, skillId: string, transaction?: Prisma.TransactionClient) {
  const db = transaction ?? prisma
  const skill = await db.agentSkillDefinition.findFirst({
    where: { id: skillId, ownerUserId: userId },
    include: { versions: { orderBy: { createdAt: 'desc' } } },
  })
  if (!skill) throw new DataAccessError(404, 'SKILL_NOT_FOUND', '技能不存在或无权编辑。')
  return skill
}

async function persistAudit(input: {
  skillId: string
  version: string
  userId: string
  contentHash: string
  findings: string[]
}): Promise<void> {
  await prisma.agentSkillAudit.create({
    data: {
      skillId: input.skillId,
      version: input.version,
      status: input.findings.length === 0 ? 'passed' : 'failed',
      findings: input.findings,
      manifestHash: input.contentHash,
      createdByUserId: input.userId,
    },
  })
}

export async function createNovelSkillDraftWithId(
  userId: string,
  novelId: string,
  input: CreateNovelSkillRequest, transaction?: Prisma.TransactionClient
): Promise<{ skillId: string; payload: NovelSkillsPayload }> {
  await assertOwnedNovel(userId, novelId, transaction)
  const version = '0.1.0'
  const source = input.source === 'agent' ? 'agent' : 'user'
  const artifacts = buildCustomSkillArtifacts(input, version, source)
  const skillId = `custom.${randomUUID()}`
  const save = async (tx: Prisma.TransactionClient) => {
    await tx.agentSkillDefinition.create({
      data: {
        id: skillId,
        ownerUserId: userId,
        name: input.name.trim(),
        description: input.description.trim(),
        source,
        visibility: 'private',
        license: artifacts.manifest.license,
        status: artifacts.findings.length === 0 ? 'draft' : 'quarantined',
        defaultVersion: version,
        versions: {
          create: {
            version,
            instructions: artifacts.instructions as Prisma.InputJsonObject,
            manifest: artifacts.manifest as unknown as Prisma.InputJsonObject,
            contentHash: artifacts.contentHash,
            status: 'draft',
          },
        },
        installations: {
          create: {
            userId,
            scope: NOVEL_SCOPE,
            scopeId: novelId,
            enabled: false,
            lockedVersion: version,
            priority: artifacts.manifest.priority,
          },
        },
      },
    })
    await tx.agentSkillAudit.create({
      data: {
        skillId,
        version,
        status: artifacts.findings.length === 0 ? 'passed' : 'failed',
        findings: artifacts.findings,
        manifestHash: artifacts.contentHash,
        createdByUserId: userId,
      },
    })
  }
  if (transaction) await save(transaction)
  else await prisma.$transaction(save)
  return { skillId, payload: await listNovelSkills(userId, novelId, transaction) }
}

/** Keep the existing API response unchanged; tool receipts also need the
 * actual created identity when an author reuses a skill name. */
export async function createNovelSkillDraft(userId: string, novelId: string, input: CreateNovelSkillRequest,
  transaction?: Prisma.TransactionClient): Promise<NovelSkillsPayload> {
  return (await createNovelSkillDraftWithId(userId, novelId, input, transaction)).payload
}

export async function importThirdPartyNovelSkill(
  userId: string,
  novelId: string,
  input: ImportThirdPartySkillRequest,
): Promise<NovelSkillsPayload> {
  await assertOwnedNovel(userId, novelId)
  const version = '0.1.0'
  const artifacts = buildCustomSkillArtifacts(input, version, 'third_party', {
    license: input.license,
    attribution: input.attribution,
    sourcePackage: input.sourcePackage,
  })
  const skillId = `third-party.${randomUUID()}`
  await prisma.$transaction(async (tx) => {
    await tx.agentSkillDefinition.create({
      data: {
        id: skillId,
        ownerUserId: userId,
        name: input.name.trim(),
        description: input.description.trim(),
        source: 'third_party',
        visibility: 'private',
        license: input.license,
        status: artifacts.findings.length === 0 ? 'draft' : 'quarantined',
        defaultVersion: version,
        versions: { create: {
          version,
          instructions: artifacts.instructions as Prisma.InputJsonObject,
          manifest: artifacts.manifest as unknown as Prisma.InputJsonObject,
          contentHash: artifacts.contentHash,
          status: 'draft',
        } },
        installations: { create: {
          userId, scope: NOVEL_SCOPE, scopeId: novelId, enabled: false,
          lockedVersion: version, priority: artifacts.manifest.priority,
        } },
      },
    })
    await tx.agentSkillAudit.create({ data: {
      skillId,
      version,
      status: artifacts.findings.length === 0 ? 'passed' : 'failed',
      findings: artifacts.findings,
      manifestHash: artifacts.contentHash,
      createdByUserId: userId,
    } })
  })
  return listNovelSkills(userId, novelId)
}

export async function createNovelSkillVersion(
  userId: string,
  novelId: string,
  skillId: string,
  input: CreateNovelSkillVersionRequest,
): Promise<NovelSkillsPayload> {
  await assertOwnedNovel(userId, novelId)
  const existing = await findOwnedSkill(userId, skillId)
  const existingVersion = existing.versions.find((version) => version.version === existing.defaultVersion)
  const existingManifest = existingVersion?.manifest && typeof existingVersion.manifest === 'object' && !Array.isArray(existingVersion.manifest)
    ? existingVersion.manifest as Record<string, unknown>
    : null
  const provenance = existing.source === 'third_party'
    ? {
        license: existing.license,
        attribution: typeof existingManifest?.attribution === 'string' ? existingManifest.attribution : '',
        sourcePackage: typeof existingManifest?.sourcePackage === 'string' ? existingManifest.sourcePackage : '',
      }
    : undefined
  const owner = existing.source === 'agent' ? 'agent' : existing.source === 'third_party' ? 'third_party' : 'user'
  const artifacts = buildCustomSkillArtifacts(input, input.version, owner, provenance)
  try {
    await prisma.agentSkillVersion.create({
      data: {
        skillId,
        version: input.version,
        instructions: artifacts.instructions as Prisma.InputJsonObject,
        manifest: artifacts.manifest as unknown as Prisma.InputJsonObject,
        contentHash: artifacts.contentHash,
        status: 'draft',
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DataAccessError(409, 'SKILL_VERSION_EXISTS', '该版本号已存在；技能版本不可覆盖，请使用新版本号。')
    }
    throw error
  }
  await persistAudit({ skillId, version: input.version, userId, contentHash: artifacts.contentHash, findings: artifacts.findings })
  return listNovelSkills(userId, novelId)
}

export async function testNovelSkill(
  userId: string,
  novelId: string,
  skillId: string,
  input: TestNovelSkillRequest, transaction?: Prisma.TransactionClient
): Promise<AgentSkillTestResult> {
  const db = transaction ?? prisma
  await assertOwnedNovel(userId, novelId, transaction)
  const skill = await findOwnedSkill(userId, skillId, transaction)
  const versionName = input.version ?? skill.defaultVersion
  const version = skill.versions.find((item) => item.version === versionName)
  if (!version) throw new DataAccessError(404, 'SKILL_VERSION_NOT_FOUND', '要测试的技能版本不存在。')
  const runtime = customSkillToRuntime({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    license: skill.license,
    version: version.version,
    manifest: version.manifest,
    instructions: version.instructions,
  })
  if (!runtime) throw new DataAccessError(409, 'SKILL_MANIFEST_INVALID', '技能清单不完整，无法测试。')
  const blockedByNegativeTrigger = runtime.negativeTriggers.some((pattern) => pattern.test(input.prompt))
  const decision = routeSkills({
    mode: input.mode,
    prompt: input.prompt,
    intent: input.intent,
    phase: input.phase,
    freedom: 'balanced',
    catalog: [runtime],
    enabledSkillIds: new Set([skillId]),
  })
  const candidate = decision.candidates.find((item) => item.skill.id === skillId)
  const matched = decision.selected.some((item) => item.id === skillId)
  const result: AgentSkillTestResult = {
    skillId,
    version: version.version,
    matched,
    expected: input.expectMatch,
    passed: matched === input.expectMatch,
    score: candidate?.score ?? 0,
    reasonCodes: candidate?.reasonCodes ?? [],
    blockedByNegativeTrigger,
    estimatedTokens: decision.estimatedTokens,
  }
  const writes = [
    db.agentSkillEval.create({
      data: {
        skillId,
        version: version.version,
        userId,
        novelId,
        promptHash: createHash('sha256').update(input.prompt).digest('hex'),
        input: input as unknown as Prisma.InputJsonObject,
        result: result as unknown as Prisma.InputJsonObject,
        passed: result.passed,
      },
    }),
    db.agentSkillVersion.update({ where: { id: version.id }, data: { status: version.status === 'active' ? 'active' : 'testing' } }),
  ]
  if (transaction) { for (const write of writes) await write }
  else await prisma.$transaction(writes)
  return result
}

export async function publishNovelSkillVersion(
  userId: string,
  novelId: string,
  skillId: string,
  version: string, transaction?: Prisma.TransactionClient
): Promise<NovelSkillsPayload> {
  const db = transaction ?? prisma
  await assertOwnedNovel(userId, novelId, transaction)
  await findOwnedSkill(userId, skillId, transaction)
  const [skillVersion, audit, evaluations] = await Promise.all([
    db.agentSkillVersion.findUnique({ where: { skillId_version: { skillId, version } } }),
    db.agentSkillAudit.findFirst({ where: { skillId, version }, orderBy: { createdAt: 'desc' } }),
    db.agentSkillEval.findMany({ where: { skillId, version, passed: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  if (!skillVersion) throw new DataAccessError(404, 'SKILL_VERSION_NOT_FOUND', '要发布的技能版本不存在。')
  if (!audit || audit.status !== 'passed') {
    throw new DataAccessError(409, 'SKILL_AUDIT_REQUIRED', '技能未通过静态安全与许可证审计，不能发布。')
  }
  const passedExpectations = new Set(evaluations.flatMap((evaluation) => {
    if (!evaluation.input || typeof evaluation.input !== 'object' || Array.isArray(evaluation.input)) return []
    const expectation = (evaluation.input as Record<string, unknown>).expectMatch
    return typeof expectation === 'boolean' ? [expectation] : []
  }))
  if (!passedExpectations.has(true) || !passedExpectations.has(false)) {
    throw new DataAccessError(409, 'SKILL_TEST_REQUIRED', '发布前必须各通过一条“应命中”和“不应命中”测试。')
  }
  const manifest = skillVersion.manifest as Record<string, unknown>
  const writes = [
    db.agentSkillVersion.update({ where: { id: skillVersion.id }, data: { status: 'active' } }),
    db.agentSkillDefinition.update({
      where: { id: skillId },
      data: { status: 'active', defaultVersion: version },
    }),
    db.agentSkillInstallation.upsert({
      where: { skillId_userId_scope_scopeId: { skillId, userId, scope: NOVEL_SCOPE, scopeId: novelId } },
      create: { skillId, userId, scope: NOVEL_SCOPE, scopeId: novelId, enabled: true, lockedVersion: version, priority: typeof manifest.priority === 'number' ? manifest.priority : 70 },
      update: { enabled: true, lockedVersion: version, priority: typeof manifest.priority === 'number' ? manifest.priority : 70 },
    }),
  ]
  if (transaction) { for (const write of writes) await write }
  else await prisma.$transaction(writes)
  return listNovelSkills(userId, novelId, transaction)
}

export async function deleteNovelSkill(userId: string, novelId: string, skillId: string): Promise<NovelSkillsPayload> {
  await assertOwnedNovel(userId, novelId)
  await findOwnedSkill(userId, skillId)
  await prisma.agentSkillDefinition.delete({ where: { id: skillId } })
  return listNovelSkills(userId, novelId)
}

/** 运行时目录：内置代码资产 + 当前作品已启用且已发布的私有技能。 */
export async function resolveRuntimeSkillContext(userId: string, novelId: string, runId?: string, transaction?: Prisma.TransactionClient): Promise<{ catalog: AgentSkill[]; routerVersion: string }> {
  const db = transaction ?? prisma
  let saved = runId ? await db.agentSkillRun.findFirst({ where: { runId, userId, novelId } }) : null
  const run = runId ? await db.agentRun.findFirst({ where: { id: runId, userId, novelId }, select: { runtimeProtocolVersion: true, taskRootId: true, status: true } }) : null
  if (runId && !run && !saved) throw new DataAccessError(409, 'SKILL_RUN_SCOPE_MISMATCH', '技能加载不属于当前作者和作品的任务。')
  // Durable tasks already own a configuration hash. Read/validate that exact
  // snapshot; neither a catalog lookup nor a resume may rewrite it.
  const durable = run?.runtimeProtocolVersion === 1 && run.taskRootId
    && await db.agentExecutionState.findUnique({ where: { taskRootId: run.taskRootId }, select: { taskRootId: true } })
    ? transaction
      ? await (await import('../runtime-state.js')).readExecutionStateInTransaction(transaction, run.taskRootId!)
      : await (await import('../runtime-state.js')).loadExecutionState(userId, runId!)
    : null
  if (run && !durable) {
    const original = await (await import('../original-request.js')).readOriginalTaskRequest(db, { userId, novelId, runId: runId! })
    if (original.sourceRunId !== runId) {
      const source = await db.agentSkillRun.findFirst({ where: { runId: original.sourceRunId, userId, novelId } })
      if (source) saved = { ...source, loaded: [...readSelected(source.loaded), ...readSelected(saved?.loaded ?? [])], selected: source.selected }
    }
  }
  const installations = await db.agentSkillInstallation.findMany({
    where: { userId, scope: NOVEL_SCOPE, scopeId: novelId },
    include: { skill: { include: { versions: true } } },
  })
  const installationBySkill = new Map(installations.map((installation) => [installation.skillId, installation]))
  const routerVersion = durable ? durable.configuration.skillRouterVersion ?? '3.1.0' : saved?.routerVersion ?? SKILL_ROUTER_VERSION
  const builtinCatalog = routerVersion === '3.6.0' ? frozenV350BuiltinCatalog
    : routerVersion === '3.7.0' ? frozenV360BuiltinCatalog
      : routerVersion !== SKILL_ROUTER_VERSION ? historicalBuiltinCatalog : skillCatalog
  const pinned = new Map([...readSelected(saved?.loaded ?? []), ...readSelected(saved?.selected ?? [])].map(item => [item.id, item.version]))
  const frozenInventory = durable?.configuration.skillInventoryVersion === 1
    ? new Map(durable.configuration.pinnedSkillVersions.map(item => [item.id, item.version])) : null
  for (const item of durable?.configuration.pinnedSkillVersions ?? []) pinned.set(item.id, item.version)
  const runtime: AgentSkill[] = []
  for (const skill of builtinCatalog) {
    if (frozenInventory && !frozenInventory.has(skill.id)) continue
    if (installationBySkill.get(skill.id)?.enabled === false) continue
    const versionName = pinned.get(skill.id)
    if (!versionName || versionName === skill.version) { runtime.push(skill); continue }
    const stored = await db.agentSkillVersion.findUnique({ where: { skillId_version: { skillId: skill.id, version: versionName } } })
    if (!stored || stored.status !== 'active' || !stored.instructions || typeof stored.instructions !== 'object' || Array.isArray(stored.instructions)) {
      throw new DataAccessError(409, 'SKILL_FROZEN_VERSION_UNAVAILABLE', '原任务的技能版本不可用，不能替换为新版本继续。')
    }
    const resources = Object.fromEntries(Object.entries(stored.instructions).filter(([phase, value]) => skill.phases.includes(phase as AgentSkill['phases'][number]) && typeof value === 'string'))
    runtime.push({ ...skill, version: versionName, resources })
  }
  for (const installation of installations) {
    if (frozenInventory && !frozenInventory.has(installation.skillId)) continue
    // Old selected-only snapshots do not attest to any unpinned private
    // version. Keep their historical built-ins, never add a later install.
    if (durable && !frozenInventory && !pinned.has(installation.skillId)) continue
    if (!installation.enabled || installation.skill.source === BUILTIN_SOURCE || installation.skill.status !== 'active') continue
    const versionName = pinned.get(installation.skillId) ?? installation.lockedVersion ?? installation.skill.defaultVersion
    const version = installation.skill.versions.find((item) => item.version === versionName && item.status === 'active')
    if (!version) {
      if (pinned.has(installation.skillId)) throw new DataAccessError(409, 'SKILL_FROZEN_VERSION_UNAVAILABLE', '原任务的技能版本不可用，不能替换为新版本继续。')
      continue
    }
    const custom = customSkillToRuntime({
      id: installation.skill.id,
      name: installation.skill.name,
      description: installation.skill.description,
      source: installation.skill.source,
      license: installation.skill.license,
      version: version.version,
      manifest: version.manifest,
      instructions: version.instructions,
    })
    if (custom) runtime.push(custom)
    else if (pinned.has(installation.skillId)) throw new DataAccessError(409, 'SKILL_FROZEN_VERSION_UNAVAILABLE', '原任务的技能资源无效，不能忽略后继续。')
  }
  return { catalog: runtime, routerVersion }
}

export async function resolveEnabledRuntimeSkills(userId: string, novelId: string, runId?: string, transaction?: Prisma.TransactionClient): Promise<AgentSkill[]> {
  return (await resolveRuntimeSkillContext(userId, novelId, runId, transaction)).catalog
}

/** 路由热路径不做目录同步；没有安装记录等价于默认启用，关闭后下一轮立即生效。 */
export async function resolveEnabledBuiltinSkillIds(userId: string, novelId: string): Promise<Set<string>> {
  const installations = await prisma.agentSkillInstallation.findMany({
    where: { userId, scope: NOVEL_SCOPE, scopeId: novelId },
    select: { skillId: true, enabled: true },
  })
  const enabledById = new Map(installations.map((installation) => [installation.skillId, installation.enabled]))
  return new Set(skillCatalog.filter((skill) => enabledById.get(skill.id) !== false).map((skill) => skill.id))
}
