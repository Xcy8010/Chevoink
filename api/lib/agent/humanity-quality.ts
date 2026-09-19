import { createHash } from 'node:crypto'

import type {
  ChapterQualityReport,
  Prisma,
  QualityFindingDisposition,
  QualityFindingFeedback,
  StoryCompilerMode,
} from '@prisma/client'

import type {
  CharacterVoiceProfileInput,
  CriticQualityFinding,
  ExperienceAnchorInput,
  HumanityQualitySignal,
} from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { taskSpecSchema } from '../../../shared/contracts/index.js'
import { compilationRunScope } from './story-compiler.js'
import { requiresNextChapterDelivery } from './completion-guard.js'
import { isAgent2FeatureEnabled } from '../agent2-feature-flags.js'
import { assertCraftOutputSafe } from './craft-library.js'
import { recalcNovelStats } from './tools/novel-tools.js'
import { enqueueChapterMemoryExtraction } from './story-memory.js'

export const HUMANITY_CRITIC_VERSION = 'humanity-critic.v2'
export const MAX_QUALITY_REPAIR_ROUNDS = 1

export type LocatedQualityFinding = {
  signal: HumanityQualitySignal
  source: 'deterministic' | 'critic'
  severity: 'advisory' | 'warning' | 'error'
  start: number
  end: number
  evidence: string
  explanation: string
  suggestion: string
  confidence: number
}

type Paragraph = { text: string; start: number; end: number }
type Sentence = { text: string; start: number; end: number }

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex')
const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, max - 1)}…`
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function splitParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = []
  const matcher = /[^\n]+/g
  let match: RegExpExecArray | null
  while ((match = matcher.exec(content))) {
    const raw = match[0]
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (!text) continue
    const start = match.index + leading
    paragraphs.push({ text, start, end: start + text.length })
  }
  return paragraphs
}

function splitSentences(content: string): Sentence[] {
  const sentences: Sentence[] = []
  const matcher = /[^。！？!?…\n]+(?:[。！？!?…]+|$)/g
  let match: RegExpExecArray | null
  while ((match = matcher.exec(content))) {
    const raw = match[0]
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text.length < 2) continue
    const start = match.index + leading
    sentences.push({ text, start, end: start + text.length })
  }
  return sentences
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function chineseBigrams(value: string): Set<string> {
  const compact = value.replace(/[\s，。！？!?、：“”‘’（）()—…]/g, '')
  const result = new Set<string>()
  for (let index = 0; index < compact.length - 1; index += 1) result.add(compact.slice(index, index + 2))
  return result
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function evidenceFinding(input: Omit<LocatedQualityFinding, 'evidence'> & { content: string }): LocatedQualityFinding {
  const { content, ...finding } = input
  const end = Math.min(input.end, input.start + 360)
  return { ...finding, end, evidence: content.slice(input.start, end) }
}

export function analyzeDeterministicQuality(content: string, recentChapterTexts: string[] = []): {
  metrics: Record<string, number | string[]>
  findings: LocatedQualityFinding[]
} {
  const paragraphs = splitParagraphs(content)
  const sentences = splitSentences(content)
  const sentenceLengths = sentences.map((item) => item.text.replace(/\s/g, '').length)
  const findings: LocatedQualityFinding[] = []
  const medianSentenceChars = median(sentenceLengths)
  const dialogueChars = paragraphs
    .filter((item) => /^[“「『"]/.test(item.text) || /[”」』"]\s*$/.test(item.text))
    .reduce((sum, item) => sum + item.text.length, 0)

  for (let index = 1; index < paragraphs.length; index += 1) {
    const previous = splitSentences(paragraphs[index - 1].text).map((item) => item.text.length)
    const current = splitSentences(paragraphs[index].text).map((item) => item.text.length)
    const previousMedian = median(previous)
    const currentMedian = median(current)
    const ratio = Math.max(previousMedian, currentMedian) / Math.max(1, Math.min(previousMedian, currentMedian))
    if (ratio >= 2.8 && paragraphs[index].text.length >= 70 && paragraphs[index - 1].text.length >= 40) {
      findings.push(evidenceFinding({
        signal: 'style_drift', source: 'deterministic', severity: 'advisory', confidence: 0.72,
        start: paragraphs[index].start, end: paragraphs[index].end, content,
        explanation: `相邻段落句长中位数从 ${Math.round(previousMedian)} 变为 ${Math.round(currentMedian)}，变化达到 ${ratio.toFixed(1)} 倍；这里只提示漂移，不判定长句或短句本身错误。`,
        suggestion: '核对该变化是否来自视角、场景节奏或作者有意处理；若不是，只调整这一段的句群节奏。',
      }))
    }
  }

  for (let index = 1; index < sentences.length; index += 1) {
    const similarity = jaccard(chineseBigrams(sentences[index - 1].text), chineseBigrams(sentences[index].text))
    if (similarity >= 0.58 && Math.min(sentences[index - 1].text.length, sentences[index].text.length) >= 12) {
      findings.push(evidenceFinding({
        signal: 'explanation_echo', source: 'deterministic', severity: 'warning', confidence: Math.min(0.95, similarity),
        start: sentences[index].start, end: sentences[index].end, content,
        explanation: `本句与前句词组重合度为 ${similarity.toFixed(2)}，可能在动作或对白后再次解释同一信息。`,
        suggestion: '优先删除重复解释；若承担新信息，只保留新增部分。',
      }))
    }
  }

  for (let index = 0; index <= sentences.length - 3; index += 1) {
    const group = sentences.slice(index, index + 3)
    const openings = group.map((item) => item.text.replace(/^[“「『"'‘’\s]+/, '').slice(0, 3))
    const lengths = group.map((item) => item.text.length)
    const closeLengths = Math.max(...lengths) - Math.min(...lengths) <= Math.max(5, median(lengths) * 0.18)
    if (openings.every((item) => item && item === openings[0]) || closeLengths && group.every((item) => /[，,]/.test(item.text))) {
      findings.push(evidenceFinding({
        signal: 'sentence_homology', source: 'deterministic', severity: 'advisory', confidence: 0.68,
        start: group[0].start, end: group[2].end, content,
        explanation: '连续三句具有相同起句或近似长度与停顿结构，可能形成机械排比；有意排比则可保留。',
        suggestion: '仅在非刻意修辞时打散其中一句的观察角度或信息落点，不做同义词轮换。',
      }))
      index += 2
    }
  }

  const allReference = recentChapterTexts.join('\n')
  const imageMatcher = /(像|仿佛|如同|好似)[^，。！？!?\n]{2,28}/g
  const seen = new Map<string, number>()
  let image: RegExpExecArray | null
  while ((image = imageMatcher.exec(content))) {
    const normalized = image[0].replace(/\s/g, '')
    const priorCount = seen.get(normalized) ?? 0
    const repeatedRecently = allReference.includes(normalized)
    if (priorCount > 0 || repeatedRecently) {
      findings.push(evidenceFinding({
        signal: 'image_repetition', source: 'deterministic', severity: 'advisory', confidence: repeatedRecently ? 0.78 : 0.7,
        start: image.index, end: image.index + image[0].length, content,
        explanation: repeatedRecently ? '这个完整意象在近期章节已经出现。' : '这个完整意象在本章重复出现。',
        suggestion: '若不是主题回声，保留最有效的一处，其余改为人物动作、物件变化或直接叙述。',
      }))
    }
    seen.set(normalized, priorCount + 1)
  }

  // 「」在本站正文里只承担人物话语或逐字引文标记。模型偶尔把它当成
  // “圈重点”符号包住转场、画面或叙述过程；这类长片段可确定性定位，交给
  // 局部修订器只去掉误用符号，不改正文事实与句子骨架。
  const cornerQuoteMatcher = /「([^」\n]{18,360})」/g
  let cornerQuote: RegExpExecArray | null
  while ((cornerQuote = cornerQuoteMatcher.exec(content))) {
    const inner = cornerQuote[1]
    const narrationCue = /[（）()]|(?:镜头|画面|转场|那段|过程|一路|拐进|挤着|穿过|进入|走到|来到|门内|屋里)/.test(inner)
    if (!narrationCue) continue
    findings.push(evidenceFinding({
      signal: 'punctuation_misuse', source: 'deterministic', severity: 'warning', confidence: 0.9,
      start: cornerQuote.index, end: cornerQuote.index + cornerQuote[0].length, content,
      explanation: '这段包含转场、画面或动作过程，却被「」整体包裹；「」不能作为叙述段落的视觉强调符号。',
      suggestion: '保留原叙述内容，只移除误用的「」；人物直接说出或逐字引用的内容不改。',
    }))
  }

  const deduplicated = findings.filter((finding, index, all) =>
    all.findIndex((item) => item.signal === finding.signal && item.start === finding.start && item.end === finding.end) === index)
  return {
    metrics: {
      paragraphCount: paragraphs.length,
      sentenceCount: sentences.length,
      medianSentenceChars: Math.round(medianSentenceChars * 10) / 10,
      maxSentenceChars: sentenceLengths.length ? Math.max(...sentenceLengths) : 0,
      dialogueRatio: content.length ? Math.round((dialogueChars / content.length) * 1_000) / 1_000 : 0,
      deterministicSignalCount: deduplicated.length,
      deterministicSignals: [...new Set(deduplicated.map((item) => item.signal))],
    },
    findings: deduplicated.slice(0, 20),
  }
}

export async function getOwnedQualityChapter(userId: string, novelId: string, chapterId: string, db: Prisma.TransactionClient = prisma) {
  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, ...activeChapterScope(novelId), authorId: userId },
    include: { novel: { select: { title: true, categoryName: true, tagNames: true } } },
  })
  if (!chapter) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '章节不存在或不属于当前作品。')
  return chapter
}

export async function qualityCompilationScope(db: Prisma.TransactionClient, userId: string, novelId: string, runId?: string | null): Promise<Prisma.StoryCompilationWhereInput> {
  if (!runId) return {}
  try {
    return await compilationRunScope(db, { userId, novelId, runId })
  } catch (error) {
    if (error instanceof DataAccessError && error.code === 'RUN_NOT_FOUND') throw new DataAccessError(409, 'QUALITY_RUN_SCOPE_INVALID', '质量检查不属于当前作品任务。')
    throw error
  }
}

/** Server-side next-chapter delivery evidence, including resumed task lineage. */
export async function hasCommittedTaskChapter(db: Prisma.TransactionClient, userId: string, novelId: string, runId: string): Promise<boolean> {
  const scope = await qualityCompilationScope(db, userId, novelId, runId)
  const rows = await db.storyCompilation.findMany({
    where: { userId, novelId, ...scope, status: { not: 'abandoned' } },
    select: { status: true, stage: true, chapterId: true,
      chapter: { select: { id: true, novelId: true, revision: true, wordCount: true, archivedAt: true,
        volume: { select: { novelId: true, archivedAt: true } } } },
      bridge: { select: { toChapterId: true, targetRevision: true, committedAt: true } } },
  })
  return rows.length > 0 && rows.every(row => row.status === 'completed' && row.stage === 'commit'
    && row.chapter && row.chapter.novelId === novelId && row.chapter.wordCount > 0
    && row.chapter.archivedAt === null && row.chapter.volume.archivedAt === null && row.chapter.volume.novelId === novelId
    && row.chapterId === row.chapter.id && row.bridge?.toChapterId === row.chapter.id
    && row.bridge.committedAt !== null && row.bridge.targetRevision === row.chapter.revision)
}

/** Explicit targets win; omitted targets belong to the active task, not a stale editor tab. */
export async function resolveQualityChapterTarget(
  input: { userId: string; novelId: string; runId?: string; chapterId?: string; compilationId?: string; fallbackChapterId?: string | null },
  db: Prisma.TransactionClient = prisma,
) {
  if (input.runId) {
    const run = await db.agentRun.findFirst({ where: { id: input.runId, userId: input.userId, novelId: input.novelId }, select: { taskSpec: true } })
    const task = taskSpecSchema.safeParse(run?.taskSpec)
    if (task.success && task.data.runId === input.runId && task.data.scope.novelId === input.novelId && requiresNextChapterDelivery(task.data.goals)) {
      const scope = await qualityCompilationScope(db, input.userId, input.novelId, input.runId)
      const targets = await db.storyCompilation.findMany({
        where: { userId: input.userId, novelId: input.novelId, status: 'active', ...scope,
          ...(input.chapterId ? { chapterId: input.chapterId } : {}), ...(input.compilationId ? { id: input.compilationId } : {}) },
        select: { chapterId: true }, take: 2,
      })
      if (targets.length === 1 && targets[0].chapterId) return targets[0].chapterId
      throw new DataAccessError(409, 'QUALITY_TASK_TARGET_REQUIRED', '当前任务要求写下一章，请先准备并写入本任务的新章，再检查质量；不能回到历史旧章重复修订。')
    }
  }
  if (input.chapterId) return input.chapterId
  if (!input.runId) {
    if (input.compilationId) throw new DataAccessError(409, 'QUALITY_RUN_SCOPE_INVALID', '请在当前任务中指定质量检查的章节。')
    return input.fallbackChapterId
  }
  const scope = await qualityCompilationScope(db, input.userId, input.novelId, input.runId)
  const candidates = await db.storyCompilation.findMany({
    where: { userId: input.userId, novelId: input.novelId, status: 'active', ...scope, ...(input.compilationId ? { id: input.compilationId } : {}) },
    select: { chapterId: true }, take: 2,
  })
  if (candidates.length === 1 && candidates[0].chapterId) return candidates[0].chapterId
  if (candidates.length > 0 || input.compilationId) {
    throw new DataAccessError(409, 'QUALITY_TARGET_AMBIGUOUS', '当前编译的质量检查目标未确定，请明确传入章节与编译编号；本次未调用模型。')
  }
  return input.fallbackChapterId
}

export async function buildHumanityQualityContext(userId: string, novelId: string, chapterId: string, runId?: string, db: Prisma.TransactionClient = prisma) {
  const chapter = await getOwnedQualityChapter(userId, novelId, chapterId, db)
  const scope = await qualityCompilationScope(db, userId, novelId, runId)
  const [charter, compilation, profiles, anchors, recentChapters, feedback, dataControl] = await Promise.all([
    db.storyCharter.findUnique({ where: { novelId } }),
    db.storyCompilation.findFirst({
      where: { userId, novelId, chapterId, status: 'active', ...scope },
      include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    }),
    db.characterVoiceProfile.findMany({ where: { userId, novelId, status: 'confirmed' }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 12 }),
    db.experienceAnchor.findMany({ where: { userId, novelId, status: 'confirmed' }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 30 }),
    db.chapter.findMany({
      where: { ...activeChapterScope(novelId), orderIndex: { lt: chapter.orderIndex } },
      select: { title: true, content: true, orderIndex: true }, orderBy: { orderIndex: 'desc' }, take: 3,
    }),
    db.qualityFinding.groupBy({
      by: ['signal', 'authorFeedback'], where: { userId, novelId, authorFeedback: { not: null } }, _count: { _all: true }, orderBy: [{ signal: 'asc' }, { authorFeedback: 'asc' }],
    }),
    db.agentDataControl.findUnique({ where: { userId_novelId: { userId, novelId } }, select: { qualityTelemetryEnabled: true } }),
  ])

  const mentionedProfiles = profiles.filter((profile) => chapter.content.includes(profile.characterName)).slice(0, 6)
  const mentionedNames = new Set(mentionedProfiles.map((profile) => profile.characterName))
  const relevantAnchors = anchors
    .filter((anchor) => mentionedNames.has(anchor.characterName) || chapter.content.includes(anchor.characterName))
    .sort((left, right) => {
      const leftScore = Number(chapter.content.includes(left.triggerEvent.slice(0, 12))) + Number(chapter.content.includes(left.sensoryCue.slice(0, 8)))
      const rightScore = Number(chapter.content.includes(right.triggerEvent.slice(0, 12))) + Number(chapter.content.includes(right.sensoryCue.slice(0, 8)))
      return rightScore - leftScore
    })
    .slice(0, 3)

  return { chapter, charter, compilation, profiles: mentionedProfiles, anchors: relevantAnchors, recentChapters, feedback: dataControl?.qualityTelemetryEnabled === false ? [] : feedback }
}

export function locateCriticFindings(content: string, findings: CriticQualityFinding[]): LocatedQualityFinding[] {
  const located: LocatedQualityFinding[] = []
  const occupied = new Set<string>()
  for (const finding of findings) {
    const quote = finding.quote.trim()
    let start = content.indexOf(quote)
    if (!quote || start < 0 || content.indexOf(quote, start + 1) >= 0) continue
    while (start >= 0 && occupied.has(`${finding.signal}:${start}`)) start = content.indexOf(quote, start + 1)
    if (start < 0) continue
    occupied.add(`${finding.signal}:${start}`)
    located.push({
      signal: finding.signal,
      source: 'critic',
      severity: finding.severity,
      start,
      end: start + quote.length,
      evidence: clip(quote, 360),
      explanation: finding.explanation,
      suggestion: finding.suggestion,
      confidence: finding.confidence,
    })
  }
  return located
}

export function prepareQualityFindings(content: string, deterministicFindings: LocatedQualityFinding[], criticFindings: CriticQualityFinding[], criticComplete: boolean) {
  const located = locateCriticFindings(content, criticFindings)
  const all = [...deterministicFindings, ...located].filter((finding, index, values) => values.findIndex(item => item.signal === finding.signal && item.start === finding.start && item.end === finding.end) === index)
  return { findings: all.slice(0, 36), complete: criticComplete && located.length === criticFindings.length && all.length <= 36,
    unlocatedFindings: criticFindings.length - located.length, omittedFindings: Math.max(0, all.length - 36) }
}

export async function persistHumanityQualityReport(input: {
  userId: string
  novelId: string
  runId?: string
  compilationId?: string
  chapterId: string
  chapterRevision: number
  mode: StoryCompilerMode
  deterministicMetrics: Record<string, number | string[]>
  deterministicFindings: LocatedQualityFinding[]
  criticFindings: CriticQualityFinding[]
  /** Explicit successful independent response, never inferred from an empty array. */
  criticComplete?: boolean
}, transaction?: Prisma.TransactionClient): Promise<ChapterQualityReport & { findings: Array<{ id: string; signal: string; source: string; severity: string; startOffset: number; endOffset: number; evidenceExcerpt: string; explanation: string; suggestion: string; disposition: QualityFindingDisposition }> }> {
  if (!transaction) return prisma.$transaction(tx => persistHumanityQualityReport(input, tx))
  const tx = transaction
  await lockNovelActiveScope(tx, input.novelId)
  if (input.runId) await assertAgentManuscriptCurrent(tx, { userId: input.userId, novelId: input.novelId, runId: input.runId })
  await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${input.chapterId} AND author_id = ${input.userId} AND novel_id = ${input.novelId} FOR UPDATE`
  const chapter = await getOwnedQualityChapter(input.userId, input.novelId, input.chapterId, tx)
  if (chapter.revision !== input.chapterRevision) throw new DataAccessError(409, 'QUALITY_SOURCE_STALE', '章节在质量检查期间已被修改，请基于最新版本重新检查。')

  const { findings, complete, unlocatedFindings, omittedFindings } = prepareQualityFindings(chapter.content, input.deterministicFindings, input.criticFindings, input.criticComplete === true)
  const actionableCount = findings.filter((finding) => finding.severity !== 'advisory').length
  const scope = await qualityCompilationScope(tx, input.userId, input.novelId, input.runId)
  if (input.compilationId && !await tx.storyCompilation.findFirst({ where: { id: input.compilationId, userId: input.userId, novelId: input.novelId, chapterId: input.chapterId, ...scope } })) {
    throw new DataAccessError(409, 'QUALITY_COMPILATION_SCOPE_INVALID', '质量报告的编译任务与目标章节不一致。')
  }
  await tx.chapterQualityReport.updateMany({
    where: { userId: input.userId, novelId: input.novelId, chapterId: input.chapterId, chapterRevision: { not: chapter.revision }, status: { not: 'stale' } },
    data: { status: 'stale' },
  })
  return tx.chapterQualityReport.create({
    data: {
      userId: input.userId, novelId: input.novelId, runId: input.runId, compilationId: input.compilationId,
      chapterId: input.chapterId, chapterRevision: chapter.revision, mode: input.mode,
      status: !complete ? 'failed' : actionableCount > 0 ? 'needs_repair' : 'passed', repairRound: 0,
      deterministicMetrics: { ...input.deterministicMetrics, independentCheck: complete ? 'complete' : 'unavailable', contentHash: hashText(chapter.content),
        unlocatedFindings, omittedFindings } as Prisma.InputJsonValue,
      criticVersion: HUMANITY_CRITIC_VERSION, checkedAt: new Date(),
      findings: {
        create: findings.map((finding) => ({
          userId: input.userId, novelId: input.novelId, signal: finding.signal, source: finding.source,
          severity: finding.severity, startOffset: finding.start, endOffset: finding.end,
          evidenceExcerpt: finding.evidence, evidenceHash: hashText(chapter.content.slice(finding.start, finding.end)),
          explanation: finding.explanation, suggestion: finding.suggestion, confidence: finding.confidence,
        })),
      },
    },
    include: { findings: { orderBy: [{ severity: 'desc' }, { startOffset: 'asc' }] } },
  })
}

export async function getQualityReport(userId: string, novelId: string, reportId: string, db: Prisma.TransactionClient = prisma) {
  const report = await db.chapterQualityReport.findFirst({
    where: { id: reportId, userId, novelId },
    include: { chapter: true, findings: { orderBy: [{ startOffset: 'asc' }] } },
  })
  if (!report) throw new DataAccessError(404, 'QUALITY_REPORT_NOT_FOUND', '质量报告不存在或不属于当前作品。')
  return report
}

export async function getLatestQualityReport(userId: string, novelId: string, chapterId: string, db: Prisma.TransactionClient = prisma) {
  return db.chapterQualityReport.findFirst({
    where: { userId, novelId, chapterId }, include: { findings: { orderBy: { startOffset: 'asc' } } }, orderBy: { createdAt: 'desc' },
  })
}

export async function selectQualityFindings(userId: string, novelId: string, reportId: string, selectedIds: string[]) {
  const report = await getQualityReport(userId, novelId, reportId)
  if (report.chapter.revision !== report.chapterRevision) throw new DataAccessError(409, 'QUALITY_REPORT_STALE', '章节已变化，请重新检查后再选择修订项。')
  const allowed = new Set(report.findings.map((finding) => finding.id))
  if (selectedIds.some((id) => !allowed.has(id))) throw new DataAccessError(400, 'QUALITY_FINDING_SCOPE_INVALID', '存在不属于该报告的质量问题。')
  await prisma.$transaction([
    prisma.qualityFinding.updateMany({ where: { reportId, id: { in: selectedIds } }, data: { disposition: 'selected' } }),
    prisma.qualityFinding.updateMany({ where: { reportId, id: { notIn: selectedIds }, disposition: { in: ['pending', 'selected'] } }, data: { disposition: 'pending' } }),
  ])
  return getQualityReport(userId, novelId, reportId)
}

export async function applyQualityRepair(input: {
  userId: string
  novelId: string
  runId?: string | null
  reportId: string
  replacements: Array<{ findingId: string; replacement: string }>
}, transaction?: Prisma.TransactionClient) {
  input = { ...input, replacements: input.replacements.map(item => ({ ...item })) }
  const report = await getQualityReport(input.userId, input.novelId, input.reportId, transaction ?? prisma)
  if (report.repairRound >= MAX_QUALITY_REPAIR_ROUNDS) throw new DataAccessError(409, 'QUALITY_REPAIR_LIMIT', '单次质量检查只允许一次自动局部修订；请交由作者审阅。')
  if (report.chapter.revision !== report.chapterRevision) throw new DataAccessError(409, 'QUALITY_REPORT_STALE', '章节已变化，请重新检查后再修订。')
  const findingById = new Map(report.findings.map((finding) => [finding.id, finding]))
  const patches = input.replacements.map((replacement) => {
    const finding = findingById.get(replacement.findingId)
    if (!finding) throw new DataAccessError(400, 'QUALITY_FINDING_SCOPE_INVALID', '修订项不属于该报告。')
    const before = report.chapter.content.slice(finding.startOffset, finding.endOffset)
    if (hashText(before) !== finding.evidenceHash) throw new DataAccessError(409, 'QUALITY_EVIDENCE_STALE', '质量证据已变化，请重新检查。')
    return { finding, before, replacement: replacement.replacement }
  }).filter(patch => patch.before !== patch.replacement).sort((left, right) => right.finding.startOffset - left.finding.startOffset)
  for (let index = 1; index < patches.length; index += 1) {
    if (patches[index - 1].finding.startOffset < patches[index].finding.endOffset) {
      throw new DataAccessError(400, 'QUALITY_PATCH_OVERLAP', '选中的证据范围重叠，请分两次修订。')
    }
  }
  let after = report.chapter.content
  for (const patch of patches) {
    after = `${after.slice(0, patch.finding.startOffset)}${patch.replacement}${after.slice(patch.finding.endOffset)}`
  }
  const leakageCandidate = patches.map((patch) => patch.replacement).join('\n')
  if (after === report.chapter.content) throw new DataAccessError(409, 'QUALITY_REPAIR_NO_CHANGE', '没有实际正文变化，不消耗修订轮次，也不把问题标为已修复。')
  if (isAgent2FeatureEnabled('craftLibrary', input.userId) && leakageCandidate.trim().length >= 80) {
    await assertCraftOutputSafe({
      userId: input.userId, novelId: input.novelId, runId: input.runId, chapterId: report.chapterId, content: leakageCandidate,
    }, transaction ?? prisma)
  }
  const apply = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, input.novelId)
    if (input.runId) await assertAgentManuscriptCurrent(tx, { userId: input.userId, novelId: input.novelId, runId: input.runId })
    const scope = await qualityCompilationScope(tx, input.userId, input.novelId, input.runId)
    if (report.compilationId) await tx.$queryRaw`SELECT id FROM story_compilations WHERE id = ${report.compilationId} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM chapters WHERE id = ${report.chapter.id} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM chapter_quality_reports WHERE id = ${report.id} FOR UPDATE`
    const current = await getQualityReport(input.userId, input.novelId, input.reportId, tx)
    const fingerprint = (value: typeof current) => JSON.stringify(value.findings.map(item => ({ id: item.id, start: item.startOffset, end: item.endOffset, evidenceHash: item.evidenceHash, disposition: item.disposition })).sort((a, b) => a.id.localeCompare(b.id)))
    if (current.chapterRevision !== report.chapterRevision || current.chapter.content !== report.chapter.content || current.repairRound !== report.repairRound
      || current.status !== report.status || current.status === 'stale' || JSON.stringify(current.deterministicMetrics) !== JSON.stringify(report.deterministicMetrics)
      || fingerprint(current) !== fingerprint(report)) throw new DataAccessError(409, 'QUALITY_REPORT_STALE', '质量报告、作者选择或正文已变化，未应用旧修订。')
    const write = await tx.chapter.updateMany({
      where: { id: report.chapter.id, ...activeChapterScope(input.novelId), authorId: input.userId, revision: report.chapterRevision, content: report.chapter.content },
      data: { content: after, wordCount: after.length, revision: { increment: 1 } },
    })
    if (write.count !== 1) throw new DataAccessError(409, 'QUALITY_REPORT_STALE', '章节在修订期间已变化，请重新检查。')
    await tx.qualityFinding.updateMany({ where: { reportId: report.id, id: { in: patches.map((patch) => patch.finding.id) } }, data: { disposition: 'repaired' } })
    const updatedChapter = await tx.chapter.findUniqueOrThrow({ where: { id: report.chapter.id } })
    const metrics = report.deterministicMetrics && typeof report.deterministicMetrics === 'object' && !Array.isArray(report.deterministicMetrics) ? report.deterministicMetrics : {}
    await tx.chapterQualityReport.update({
      where: { id: report.id },
      data: { status: metrics.independentCheck === 'complete' ? 'repaired' : 'failed', chapterRevision: updatedChapter.revision, repairRound: { increment: 1 }, checkedAt: new Date(),
        deterministicMetrics: { ...metrics, repairedContentHash: hashText(after), sourceRevision: report.chapterRevision } },
    })
    if (report.compilationId) {
      const compilation = await tx.storyCompilation.findFirst({
        where: { id: report.compilationId, userId: input.userId, novelId: input.novelId, status: 'active', ...scope },
        select: { chapterId: true },
      })
      if (!compilation || compilation.chapterId !== report.chapterId) throw new DataAccessError(409, 'QUALITY_COMPILATION_SCOPE_INVALID', '修订报告的编译已结束或不属于当前任务，未改动正文。')
      if (compilation?.chapterId === report.chapterId) {
        await tx.storyCompilation.update({
          where: { id: report.compilationId },
          data: { stage: 'repair' },
        })
        await tx.sceneTask.updateMany({ where: { compilationId: report.compilationId }, data: { chapterId: report.chapterId, status: 'writing' } })
        await tx.chapterBridge.update({ where: { compilationId: report.compilationId }, data: { toChapterId: report.chapterId, targetRevision: updatedChapter.revision } })
      }
    }
    await recalcNovelStats(input.novelId, tx)
    if (isAgent2FeatureEnabled('memory2', input.userId)) await enqueueChapterMemoryExtraction({ novelId: input.novelId, chapterId: report.chapterId, chapterRevision: updatedChapter.revision, before: report.chapter.content, after }, tx)
    if (input.runId) {
      if (!await tx.agentRun.findFirst({ where: { id: input.runId, userId: input.userId, novelId: input.novelId } })) throw new DataAccessError(409, 'QUALITY_RUN_SCOPE_INVALID', '修订记录不属于当前作品任务。')
      await tx.agentArtifact.create({ data: { runId: input.runId, artifactType: 'rewriteSelection', title: `${updatedChapter.title} · 人类感自动局部修订`, content: JSON.stringify(input.replacements),
        summary: `${patches.length} 个证据范围 / r${report.chapterRevision}→r${updatedChapter.revision}`, metadata: { reportId: report.id, findingIds: patches.map(patch => patch.finding.id), sourceRevision: report.chapterRevision, targetRevision: updatedChapter.revision, phase: 'humanity_revision_auto' } } })
    }
    const { recordWritingSignal } = await import('./writing-experiments.js')
    await recordWritingSignal(input.userId, input.novelId, 'quality_revision_round', 1, tx)
    return updatedChapter
  }
  const updated = transaction ? await apply(transaction) : await prisma.$transaction(apply)
  return { report, updated, before: report.chapter.content, after, repairedFindingIds: patches.map((patch) => patch.finding.id) }
}

export async function recordQualityFindingFeedback(input: {
  userId: string
  findingId: string
  accepted: boolean
  reason?: string
}) {
  const finding = await prisma.qualityFinding.findFirst({ where: { id: input.findingId, userId: input.userId } })
  if (!finding) throw new DataAccessError(404, 'QUALITY_FINDING_NOT_FOUND', '质量问题不存在或不属于当前用户。')
  const updated = await prisma.qualityFinding.update({
    where: { id: finding.id },
    data: { authorFeedback: input.accepted ? 'accepted' : 'rejected', feedbackReason: input.reason?.trim() || null },
  })
  const { recordWritingSignal } = await import('./writing-experiments.js')
  await recordWritingSignal(input.userId, finding.novelId, input.accepted ? 'quality_feedback_accepted' : 'quality_feedback_rejected')
  return updated
}

export async function saveCharacterVoiceProfile(userId: string, novelId: string, input: CharacterVoiceProfileInput) {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或不属于当前用户。')
  if (input.confirmed) {
    if (input.voiceSamples.length < 3) throw new DataAccessError(400, 'VOICE_SAMPLE_COUNT_REQUIRED', '确认版 Voice DNA 至少需要 3 条逐字声口样本。')
    if (new Set(input.voiceSamples.map((sample) => sample.text)).size !== input.voiceSamples.length) throw new DataAccessError(400, 'VOICE_SAMPLE_DUPLICATED', '确认版声口样本不能重复。')
    for (const sample of input.voiceSamples) {
      if (!sample.sourceChapterId || !sample.sourceRevision) throw new DataAccessError(400, 'VOICE_SAMPLE_EVIDENCE_REQUIRED', '确认版声口样本必须提供章节与 revision 证据。')
      const chapter = await prisma.chapter.findFirst({ where: { id: sample.sourceChapterId, novelId, authorId: userId, revision: sample.sourceRevision }, select: { content: true } })
      if (!chapter || !chapter.content.includes(sample.text)) throw new DataAccessError(400, 'VOICE_SAMPLE_EVIDENCE_INVALID', '声口样本必须逐字存在于指定章节 revision。')
    }
  }
  const data = {
    userId, vocabularyLevel: input.vocabularyLevel, sentenceLength: input.sentenceLength,
    addressSystem: input.addressSystem, pressureResponse: input.pressureResponse, avoidedTopics: input.avoidedTopics,
    attentionBias: input.attentionBias, voiceSamples: input.voiceSamples, forbiddenKnowledge: input.forbiddenKnowledge,
    evolutionNotes: input.evolutionNotes, status: input.confirmed ? 'confirmed' as const : 'draft' as const,
  }
  return prisma.characterVoiceProfile.upsert({
    where: { novelId_characterName: { novelId, characterName: input.characterName } },
    create: { novelId, characterName: input.characterName, ...data },
    update: { ...data, revision: { increment: 1 } },
  })
}

export async function listCharacterVoiceProfiles(userId: string, novelId: string, db: Prisma.TransactionClient = prisma) {
  return db.characterVoiceProfile.findMany({ where: { userId, novelId, status: { not: 'archived' } }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] })
}

export async function saveExperienceAnchor(userId: string, novelId: string, input: ExperienceAnchorInput) {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或不属于当前用户。')
  if (input.sourceType === 'chapter') {
    if (!input.sourceRevision) throw new DataAccessError(400, 'ANCHOR_REVISION_REQUIRED', '章节经历锚点必须携带 revision。')
    const chapter = await prisma.chapter.findFirst({ where: { id: input.sourceId, novelId, authorId: userId, revision: input.sourceRevision }, select: { content: true } })
    if (!chapter || !chapter.content.includes(input.concreteDetail)) throw new DataAccessError(400, 'ANCHOR_EVIDENCE_INVALID', '经历锚点的具体细节必须存在于指定章节 revision。')
  }
  return prisma.experienceAnchor.upsert({
    where: { novelId_characterName_title_sourceId: { novelId, characterName: input.characterName, title: input.title, sourceId: input.sourceId } },
    create: { userId, novelId, ...input },
    update: input,
  })
}

export async function listExperienceAnchors(userId: string, novelId: string, characterName?: string, db: Prisma.TransactionClient = prisma) {
  return db.experienceAnchor.findMany({
    where: { userId, novelId, status: 'confirmed', ...(characterName ? { characterName } : {}) },
    orderBy: { updatedAt: 'desc' }, take: 30,
  })
}

export function renderQualityLearning(feedback: Array<{ signal: string; authorFeedback: QualityFindingFeedback | null; _count: { _all: number } }>): string {
  const bySignal = new Map<string, { accepted: number; rejected: number }>()
  for (const item of feedback) {
    const value = bySignal.get(item.signal) ?? { accepted: 0, rejected: 0 }
    if (item.authorFeedback === 'accepted') value.accepted += item._count._all
    if (item.authorFeedback === 'rejected') value.rejected += item._count._all
    bySignal.set(item.signal, value)
  }
  const lines = [...bySignal.entries()].map(([signal, counts]) => `${signal}: 接受 ${counts.accepted} / 拒绝 ${counts.rejected}`)
  return lines.length ? `作者历史反馈（只调整置信度，不覆盖本次正文证据）：${lines.join('；')}` : '作者尚无质量 finding 反馈。'
}

export function calibrateCriticFindings(
  findings: CriticQualityFinding[],
  feedback: Array<{ signal: string; authorFeedback: QualityFindingFeedback | null; _count: { _all: number } }>,
): CriticQualityFinding[] {
  const counts = new Map<string, { accepted: number; rejected: number }>()
  for (const item of feedback) {
    const current = counts.get(item.signal) ?? { accepted: 0, rejected: 0 }
    if (item.authorFeedback === 'accepted') current.accepted += item._count._all
    if (item.authorFeedback === 'rejected') current.rejected += item._count._all
    counts.set(item.signal, current)
  }
  return findings.map((finding) => {
    const signal = counts.get(finding.signal)
    const total = (signal?.accepted ?? 0) + (signal?.rejected ?? 0)
    if (!signal || total < 3) return finding
    const acceptanceRate = signal.accepted / total
    const delta = acceptanceRate >= 0.7 ? 0.1 : acceptanceRate <= 0.3 ? -0.25 : 0
    return { ...finding, confidence: Math.max(0, Math.min(1, finding.confidence + delta)) }
  })
}

export function renderVoiceAndAnchorContext(input: Awaited<ReturnType<typeof buildHumanityQualityContext>>): string {
  const profiles = input.profiles.map((profile) => {
    const samples = Array.isArray(profile.voiceSamples) ? profile.voiceSamples as Array<{ text?: unknown }> : []
    return `${profile.characterName}：词汇=${profile.vocabularyLevel}；压力反应=${clip(profile.pressureResponse, 180)}；关注=${asStrings(profile.attentionBias).slice(0, 4).join('、') || '未记'}；禁知=${asStrings(profile.forbiddenKnowledge).slice(0, 4).join('、') || '无'}；确认声口=${samples.map((sample) => typeof sample.text === 'string' ? `「${clip(sample.text, 80)}」` : '').filter(Boolean).slice(0, 3).join(' / ')}`
  })
  const anchors = input.anchors.map((anchor) => `${anchor.characterName}/${anchor.title}：${clip(anchor.concreteDetail, 180)}；触发=${clip(anchor.triggerEvent, 100)}；习惯反应=${clip(anchor.habitualResponse, 100)}`)
  return `确认版 Character Voice DNA：\n${profiles.join('\n') || '无（不得凭空编造声口规则）'}\n相关 Experience Anchors（最多 3 条）：\n${anchors.join('\n') || '无（不得用模板身体反应代替）'}`
}
