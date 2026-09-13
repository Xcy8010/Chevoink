import type { Prisma, StyleLearningJob } from '@prisma/client'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { changeStyleLearningSchema, startStyleLearningSchema, styleModelSelectionSchema, styleRuleSchema, type ChangeStyleLearning, type StartStyleLearning, type StyleLearningView, type StyleLearningWorkspace } from '../../../shared/contracts/style-learning.js'
import { prisma, DataAccessError } from '../prisma.js'
import { getModelTierRuntime } from '../credits.js'
import { generateTextCompletion } from '../ai-service.js'
import { isAgent2FeatureEnabled, requireAgent2Feature } from '../agent2-feature-flags.js'
import { chunkStyleSamples, mergeStyleRules, parseStyleAnalysis, privateSamplesSchema, renderLearnedStyle, STYLE_ANALYSIS_PROMPT } from './style-learning-analysis.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { activeChapterScope } from '../data/internal.js'

const reportsSchema = z.array(z.object({ chunk: z.number().int(), rules: z.array(styleRuleSchema) }))
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const conflict = () => new DataAccessError(409, 'STYLE_LEARNING_CONFLICT', '状态已变化，请刷新后再操作。')
const sourceArchived = () => new DataAccessError(409, 'IMPORT_SCOPE_CHANGED', '来源稿件已导入或恢复，请重新选择当前样章并创建学习任务。')
const owned = (userId: string, novelId: string) => ({ userId, novelId, kind: 'author' as const, source: { rightsStatus: 'approved' as const } })
async function assertAccess(userId: string, novelId: string, requireEnabled = false) {
  requireAgent2Feature('craftLibrary', userId)
  if (!await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
  const control = await prisma.agentDataControl.findUnique({ where: { userId_novelId: { userId, novelId } } })
  if (requireEnabled && control?.privateStyleEnabled === false) throw new DataAccessError(409, 'PRIVATE_STYLE_DISABLED', '请先在技能区开启本作品 Style DNA 数据使用。')
  return control?.privateStyleEnabled !== false
}
function identity(runtime: Awaited<ReturnType<typeof getModelTierRuntime>>) {
  return { provider: runtime.provider, model: runtime.modelName, endpointHash: createHash('sha256').update(runtime.baseUrl ?? '').digest('hex'), reasoning: runtime.reasoningEffort, multiplier: runtime.multiplierBps, price: runtime.tokenPrice ?? null }
}
function view(job: StyleLearningJob): StyleLearningView {
  const model = job.modelIdentity as { provider: string; model: string }
  return { id: job.id, profileId: job.profileId, status: job.status, revision: job.revision, enabled: job.enabled, processed: job.processed, total: (job.chunks as unknown[]).length, pauseRequested: job.pauseRequested, modelLabel: `${model.provider} / ${model.model}`, rules: z.array(styleRuleSchema).parse(job.rules), reports: reportsSchema.parse(job.reports), error: job.error, updatedAt: job.updatedAt.toISOString() }
}
async function lockNovel(tx: Prisma.TransactionClient, userId: string, novelId: string) {
  await lockNovelActiveScope(tx, novelId)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`style:${userId}:${novelId}`}, 0))::text`
}
export async function getStyleLearningWorkspace(userId: string, novelId: string): Promise<StyleLearningWorkspace> {
  const privateStyleEnabled = await assertAccess(userId, novelId)
  const profiles = await prisma.styleProfile.findMany({ where: owned(userId, novelId), orderBy: { createdAt: 'desc' }, include: { document: true, learningJobs: { orderBy: { createdAt: 'desc' } } } })
  return { privateStyleEnabled, samples: profiles.map(profile => {
    const metadata = profile.document?.metadata as { privateSamples?: unknown; uploadedFile?: { name: string }; chapters?: { title: string }[] } | null
    const samples = privateSamplesSchema.safeParse(metadata?.privateSamples)
    return { id: profile.id, sourceId: profile.sourceId!, name: profile.name, createdAt: profile.createdAt.toISOString(), chars: profile.sampleChars, canLearn: samples.success, files: samples.success ? samples.data.map(s => ({ name: s.name, chars: s.content.length })) : [...(metadata?.uploadedFile ? [{ name: metadata.uploadedFile.name, chars: 0 }] : []), ...(metadata?.chapters ?? []).map(c => ({ name: c.title, chars: 0 }))] }
  }), jobs: profiles.flatMap(profile => profile.learningJobs.map(view)) }
}
export async function previewStyleSamples(userId: string, novelId: string, profileId: string) {
  await assertAccess(userId, novelId)
  const profile = await prisma.styleProfile.findFirst({ where: { id: profileId, ...owned(userId, novelId) }, include: { document: { include: { passages: { orderBy: { ordinal: 'asc' } } } } } })
  if (!profile) throw new DataAccessError(404, 'STYLE_NOT_FOUND', '样章不存在或已撤回。')
  const metadata = profile.document?.metadata as { privateSamples?: unknown } | null
  const samples = privateSamplesSchema.safeParse(metadata?.privateSamples)
  return samples.success ? { exact: true, files: samples.data } : { exact: false, files: [{ name: '历史保存片段（非完整原文件）', content: profile.document?.passages.map(p => p.content).join('\n\n') ?? '' }] }
}
export async function startStyleLearning(userId: string, novelId: string, raw: StartStyleLearning) {
  const input = startStyleLearningSchema.parse(raw)
  await assertAccess(userId, novelId, true)
  const runtime = await getModelTierRuntime(input.model.modelTier, userId, input.model.customModelId, input.model.reasoningEffort)
  if (!runtime.apiKey || !runtime.modelName || !runtime.baseUrl) throw new DataAccessError(409, 'MODEL_UNAVAILABLE', '所选模型尚未配置完成。')
  return prisma.$transaction(async tx => {
    await lockNovel(tx, userId, novelId)
    const prior = await tx.styleLearningJob.findUnique({ where: { requestId: input.requestId }, include: { profile: true } })
    if (prior) {
      if (prior.profile.userId !== userId || prior.profile.novelId !== novelId || prior.profileId !== input.profileId || !isDeepStrictEqual(prior.selection, json(input.model))) throw conflict()
      return view(prior)
    }
    const profile = await tx.styleProfile.findFirst({ where: { id: input.profileId, ...owned(userId, novelId) }, include: { document: true } })
    if (!profile) throw new DataAccessError(404, 'STYLE_NOT_FOUND', '样章不存在或已撤回。')
    // A new request ID must not revive the retained samples of an invalidated job.
    if (await tx.styleLearningJob.count({ where: { profileId: profile.id, error: 'IMPORT_SOURCE_ARCHIVED' } })) throw sourceArchived()
    const evidence = z.array(z.object({ id: z.string().min(1), revision: z.number().int().nonnegative() })).safeParse((profile.document?.metadata as { chapters?: unknown } | null)?.chapters ?? [])
    if (!evidence.success) throw sourceArchived()
    if (evidence.data.length && await tx.chapter.count({ where: { ...activeChapterScope(novelId), authorId: userId, OR: evidence.data.map(({ id, revision }) => ({ id, revision })) } }) !== new Set(evidence.data.map(chapter => chapter.id)).size) throw sourceArchived()
    if (await tx.styleLearningJob.count({ where: { profile: owned(userId, novelId), status: { in: ['queued', 'processing', 'analyzing'] } } })) throw new DataAccessError(409, 'STYLE_LEARNING_BUSY', '本作品已有学习任务，请等待或暂停后再开始。')
    const samples = privateSamplesSchema.safeParse((profile.document?.metadata as { privateSamples?: unknown })?.privateSamples)
    if (!samples.success) throw new DataAccessError(409, 'STYLE_LEGACY_SAMPLE', '历史画像未保存完整样章，请重新上传；旧文件不会自动发送给模型。')
    const chars = samples.data.reduce((total, sample) => total + sample.content.length, 0)
    if (chars > 120_000) throw new DataAccessError(400, 'STYLE_SAMPLE_TOO_LARGE', '样章合计不能超过12万字符。')
    if (runtime.contextWindowTokens && runtime.contextWindowTokens < 16_000) throw new DataAccessError(409, 'STYLE_CONTEXT_TOO_SMALL', '学习需要至少16K上下文，请选择合适模型。')
    return view(await tx.styleLearningJob.create({ data: { requestId: input.requestId, profileId: profile.id, selection: json(input.model), modelIdentity: json(identity(runtime)), chunks: json(chunkStyleSamples(samples.data)) } }))
  })
}
export async function changeStyleLearning(userId: string, novelId: string, id: string, raw: ChangeStyleLearning) {
  const input = changeStyleLearningSchema.parse(raw)
  await assertAccess(userId, novelId, input.action !== 'disable' && input.action !== 'pause')
  return prisma.$transaction(async tx => {
    await lockNovel(tx, userId, novelId)
    const job = await tx.styleLearningJob.findFirst({ where: { id, profile: owned(userId, novelId) } })
    if (!job || job.revision !== input.revision) throw conflict()
    if (job.error === 'IMPORT_SOURCE_ARCHIVED' && ['resume', 'retry', 'enable'].includes(input.action)) throw sourceArchived()
    const data: Prisma.StyleLearningJobUpdateManyMutationInput = { revision: { increment: 1 } }
    if (input.action === 'enable' || input.action === 'disable') {
      if (job.status !== 'ready') throw conflict()
      if (input.action === 'enable') {
        if (!input.rules) throw conflict()
        const chunks = job.chunks as unknown as { content: string }[]
        if (input.rules.some(rule => !chunks.some(chunk => chunk.content.includes(rule.evidence)))) throw new DataAccessError(400, 'STYLE_EVIDENCE_INVALID', '规则依据必须来自本次学习样章；可修改建议，但不能伪造原文。')
        await tx.styleLearningJob.updateMany({ where: { id: { not: id }, enabled: true, profile: owned(userId, novelId) }, data: { enabled: false, revision: { increment: 1 } } })
        data.rules = json(input.rules)
      }
      data.enabled = input.action === 'enable'
      return view(await tx.styleLearningJob.update({ where: { id }, data }))
    }
    if (input.action === 'pause') {
      if (!['queued', 'processing', 'analyzing'].includes(job.status)) throw conflict()
      // In-flight requests finish and save evidence; pause is applied at the chunk boundary.
      data.pauseRequested = true
      if (job.status === 'queued') data.status = 'paused'
    } else {
      if (input.action === 'resume' ? job.status !== 'paused' : job.status !== 'interrupted') throw conflict()
      if (await tx.styleLearningJob.count({ where: { id: { not: id }, profile: owned(userId, novelId), status: { in: ['queued', 'processing', 'analyzing'] } } })) throw new DataAccessError(409, 'STYLE_LEARNING_BUSY', '本作品已有学习任务。')
      data.status = 'queued'; data.pauseRequested = false; data.error = null; data.response = null
    }
    const changed = await tx.styleLearningJob.updateMany({ where: { id, revision: input.revision }, data })
    if (!changed.count) throw conflict()
    return view((await tx.styleLearningJob.findUniqueOrThrow({ where: { id } })))
  })
}

let dispatching = false
const active = new Set<string>()
/** Persist before every paid call. Never automatically retry an uncertain provider outcome. */
export async function dispatchStyleLearning() {
  if (dispatching) return
  dispatching = true
  try {
    await prisma.styleLearningJob.updateMany({ where: { status: 'processing', leaseUntil: { lt: new Date() } }, data: { status: 'interrupted', error: '请求中断，供应商可能已计费。已完成分段保留；确认后才会重新分析当前段。', revision: { increment: 1 } } })
    const jobs = await prisma.styleLearningJob.findMany({ where: { status: { in: ['queued', 'analyzing'] }, id: { notIn: [...active] } }, orderBy: { createdAt: 'asc' }, take: Math.max(0, 2 - active.size) })
    for (const job of jobs) {
      active.add(job.id)
      void processStyleChunk(job).catch(() => { console.error('[style-learning] 分段保存失败，保留持久状态等待核对') }).finally(() => active.delete(job.id))
    }
  } finally { dispatching = false }
}
export async function processStyleChunk(initial: StyleLearningJob) {
  let job = initial
  if (job.status === 'queued') {
    const claimed = await prisma.styleLearningJob.updateMany({ where: { id: job.id, status: 'queued', revision: job.revision }, data: { status: 'processing', claimToken: randomUUID(), leaseUntil: new Date(Date.now() + 12 * 60_000), revision: { increment: 1 } } })
    if (!claimed.count) return
    job = await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: job.id } })
    if (job.pauseRequested) {
      await prisma.styleLearningJob.updateMany({ where: { id: job.id, status: 'processing', claimToken: job.claimToken }, data: { status: 'paused', leaseUntil: null, revision: { increment: 1 } } })
      return
    }
    let providerStarted = false
    try {
      const profile = await prisma.styleProfile.findUniqueOrThrow({ where: { id: job.profileId } })
      await assertAccess(profile.userId!, profile.novelId!, true)
      const selection = styleModelSelectionSchema.parse(job.selection)
      const runtime = await getModelTierRuntime(selection.modelTier, profile.userId!, selection.customModelId, selection.reasoningEffort)
      if (!isDeepStrictEqual(json(identity(runtime)), job.modelIdentity)) throw new DataAccessError(409, 'STYLE_MODEL_CHANGED', '模型配置或价格已变化，请重新创建学习任务并确认。')
      const sample = (job.chunks as unknown as { name: string; content: string }[])[job.processed]
      const stillActive = await prisma.styleLearningJob.findFirst({ where: { id: job.id, status: 'processing', profile: owned(profile.userId!, profile.novelId!) }, select: { id: true } })
      if (!stillActive) return
      providerStarted = true
      const response = await generateTextCompletion(STYLE_ANALYSIS_PROMPT, JSON.stringify({ sample: sample.content }), { userId: profile.userId!, novelId: profile.novelId!, action: 'style_learning', targetType: 'style_learning', targetId: `${job.id}:${job.processed}`, modelRuntime: runtime, signal: AbortSignal.timeout(10 * 60_000), temperature: 0.2 })
      // Pause may change revision, but never admits another processing attempt. Status fences stale results.
      const saved = await prisma.styleLearningJob.updateMany({ where: { id: job.id, status: 'processing', claimToken: job.claimToken }, data: { response, status: 'analyzing', leaseUntil: null, revision: { increment: 1 } } })
      if (!saved.count) return
      job = await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: job.id } })
    } catch (error) {
      const message = !providerStarted && error instanceof DataAccessError ? error.message : '当前段未完成：请检查模型配置、额度或连接。供应商可能已计费，系统不会自动重发；已完成分段保留。'
      await prisma.styleLearningJob.updateMany({ where: { id: job.id, status: 'processing', claimToken: job.claimToken }, data: { status: providerStarted ? 'interrupted' : 'paused', error: message, leaseUntil: null, revision: { increment: 1 } } })
      return
    }
  }
  if (job.status !== 'analyzing' || !job.response) return
  try {
    const chunks = job.chunks as unknown as { name: string; content: string }[]
    const rules = parseStyleAnalysis(job.response, chunks[job.processed].content)
    const reports = [...reportsSchema.parse(job.reports), { chunk: job.processed + 1, rules }]
    const processed = job.processed + 1
    await prisma.styleLearningJob.updateMany({ where: { id: job.id, status: 'analyzing', revision: job.revision }, data: { reports: json(reports), processed, rules: json(mergeStyleRules(reports)), response: null, status: processed === chunks.length ? 'ready' : job.pauseRequested ? 'paused' : 'queued', revision: { increment: 1 } } })
  } catch {
    await prisma.styleLearningJob.updateMany({ where: { id: job.id, status: 'analyzing', revision: job.revision }, data: { status: 'interrupted', error: '模型分析格式或原文依据未通过校验，未启用。当前段响应已保存；重试可能再次计费。', revision: { increment: 1 } } })
  }
}
export async function getLearnedStyleDigest(userId: string, novelId: string) {
  if (!isAgent2FeatureEnabled('craftLibrary', userId)) return ''
  const control = await prisma.agentDataControl.findUnique({ where: { userId_novelId: { userId, novelId } } })
  if (control?.privateStyleEnabled === false) return ''
  const job = await prisma.styleLearningJob.findFirst({ where: { enabled: true, status: 'ready', profile: owned(userId, novelId) }, include: { profile: true }, orderBy: { updatedAt: 'desc' } })
  return job ? renderLearnedStyle(job.profile.name, job.id, job.revision, z.array(styleRuleSchema).parse(job.rules)) : ''
}
