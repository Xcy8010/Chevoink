import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import type {
  AdminCorpusDocumentImportResult,
  CorpusDocumentImport,
  CorpusSourceCreate,
  CraftSearchQuery,
  CraftTechniqueCardView,
  LeakageCheckView,
  StyleStats,
} from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'

const HASH_VECTOR_SIZE = 128
const MAX_SEARCH_CANDIDATES = 120
const MAX_LEAKAGE_PASSAGES = 160
const AUTHOR_SAMPLE_MIN_CHARS = 500
const PASSAGE_MAX_CHARS = 1_600
const PUBLIC_LICENSE_WHITELIST = {
  public_domain: new Set(['CC0-1.0', 'PDM-1.0', 'Public Domain', '公共领域']),
  permissive: new Set(['CC-BY-4.0', 'CC-BY-SA-4.0']),
} as const
const FUNCTION_WORDS = ['的', '了', '在', '是', '就', '却', '但', '而', '还', '又', '也', '都', '才', '只', '把', '被', '让', '向', '从'] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function rounded(value: number, digits = 4): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function occurrenceCount(content: string, token: string): number {
  if (!token) return 0
  let count = 0
  let cursor = 0
  while ((cursor = content.indexOf(token, cursor)) >= 0) {
    count += 1
    cursor += token.length
  }
  return count
}

export function extractStyleStats(samples: string[]): StyleStats {
  const normalizedSamples = samples.map((sample) => sample.trim()).filter(Boolean)
  if (normalizedSamples.length === 0) throw new DataAccessError(400, 'STYLE_SAMPLE_EMPTY', '样章内容不能为空。')
  const content = normalizedSamples.join('\n')
  const compact = normalizeText(content)
  const sentences = content.split(/(?<=[。！？!?…])|\n+/).map((item) => normalizeText(item)).filter(Boolean)
  const sentenceLengths = sentences.map((sentence) => sentence.length)
  const sentenceMean = sentenceLengths.reduce((sum, length) => sum + length, 0) / Math.max(1, sentenceLengths.length)
  const variance = sentenceLengths.reduce((sum, length) => sum + (length - sentenceMean) ** 2, 0) / Math.max(1, sentenceLengths.length)
  const paragraphs = content.split(/\n+/).map((item) => normalizeText(item)).filter(Boolean)
  const dialogueChars = Array.from(content.matchAll(/[“「『"][^”」』"]+[”」』"]/g)).reduce((sum, match) => sum + normalizeText(match[0]).length, 0)
  const punctuationCount = (content.match(/[，。！？；：、,.!?;:…—]/g) ?? []).length
  const questions = (content.match(/[？?]/g) ?? []).length
  const exclamations = (content.match(/[！!]/g) ?? []).length
  const imagery = (content.match(/像是|像个|仿佛|如同|宛如|好似|似的/g) ?? []).length
  const fingerprint = Object.fromEntries(FUNCTION_WORDS.map((word) => [word, rounded(occurrenceCount(compact, word) / Math.max(1, compact.length))]))
  return {
    sampleChars: compact.length,
    sampleCount: normalizedSamples.length,
    dialogueRatio: rounded(dialogueChars / Math.max(1, compact.length)),
    medianSentenceChars: rounded(median(sentenceLengths), 2),
    sentenceLengthStdDev: rounded(Math.sqrt(variance), 2),
    medianParagraphChars: rounded(median(paragraphs.map((paragraph) => paragraph.length)), 2),
    punctuationDensity: rounded(punctuationCount / Math.max(1, compact.length)),
    questionRatio: rounded(questions / Math.max(1, sentences.length)),
    exclamationRatio: rounded(exclamations / Math.max(1, sentences.length)),
    firstPersonRatio: rounded(occurrenceCount(compact, '我') / Math.max(1, compact.length)),
    imageryDensity: rounded(imagery / Math.max(1, sentences.length)),
    functionWordFingerprint: fingerprint,
  }
}

function splitLongParagraph(paragraph: string): string[] {
  const chunks: string[] = []
  let remaining = paragraph.trim()
  while (remaining.length > PASSAGE_MAX_CHARS) {
    const window = remaining.slice(0, PASSAGE_MAX_CHARS + 1)
    const minimumCut = Math.floor(PASSAGE_MAX_CHARS * 0.55)
    let cut = -1
    for (const mark of ['。', '！', '？', '；', '…', '，', '、']) {
      cut = Math.max(cut, window.lastIndexOf(mark))
    }
    if (cut < minimumCut) cut = PASSAGE_MAX_CHARS - 1
    chunks.push(remaining.slice(0, cut + 1).trim())
    remaining = remaining.slice(cut + 1).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function splitPassages(samples: string[]): string[] {
  const passages: string[] = []
  for (const sample of samples) {
    const paragraphs = sample.split(/\n+/).flatMap(splitLongParagraph).filter(Boolean)
    let current = ''
    for (const paragraph of paragraphs) {
      if (current && current.length + paragraph.length + 1 > PASSAGE_MAX_CHARS) {
        passages.push(current)
        current = ''
      }
      current += `${current ? '\n' : ''}${paragraph}`
    }
    if (current) passages.push(current)
  }
  return passages.filter((passage) => normalizeText(passage).length >= 40)
}

export function isWhitelistedPublicLicense(sourceClass: string, license: string): boolean {
  if (sourceClass !== 'public_domain' && sourceClass !== 'permissive') return true
  return PUBLIC_LICENSE_WHITELIST[sourceClass].has(license.trim())
}

async function assertOwnedNovel(userId: string, novelId: string, db: Prisma.TransactionClient = prisma): Promise<void> {
  const novel = await db.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { id: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权访问。')
}

export async function extractAuthorStyleProfile(input: {
  userId: string
  novelId: string
  title: string
  chapterIds: string[]
  uploadedFile?: { name: string; size: number; content: string }
}, transaction?: Prisma.TransactionClient): Promise<{ profileId: string; sourceId: string; documentId: string; stats: StyleStats }> {
  const db = transaction ?? prisma
  await assertOwnedNovel(input.userId, input.novelId, db)
  const dataControl = await db.agentDataControl.findUnique({ where: { userId_novelId: { userId: input.userId, novelId: input.novelId } }, select: { privateStyleEnabled: true } })
  if (dataControl?.privateStyleEnabled === false) throw new DataAccessError(409, 'PRIVATE_STYLE_DISABLED', '当前作品已关闭 Style DNA 使用，请先在技能区的数据设置中开启。')
  const uniqueIds = [...new Set(input.chapterIds)]
  const chapters = await db.chapter.findMany({
    where: { id: { in: uniqueIds }, novelId: input.novelId, authorId: input.userId },
    orderBy: { orderIndex: 'asc' },
    select: { id: true, title: true, content: true, revision: true },
  })
  if (chapters.length !== uniqueIds.length) throw new DataAccessError(404, 'STYLE_SAMPLE_CHAPTER_NOT_FOUND', '至少一个样章不存在或不属于当前作品。')
  const uploadedSample = input.uploadedFile?.content.trim() ?? ''
  const samples = [
    ...chapters.map((chapter) => chapter.content.trim()).filter(Boolean),
    ...(uploadedSample ? [uploadedSample] : []),
  ]
  const totalChars = samples.reduce((sum, sample) => sum + normalizeText(sample).length, 0)
  if (totalChars < AUTHOR_SAMPLE_MIN_CHARS) {
    throw new DataAccessError(400, 'STYLE_SAMPLE_TOO_SHORT', `作者样章至少需要 ${AUTHOR_SAMPLE_MIN_CHARS} 个有效字符。`)
  }
  const stats = extractStyleStats(samples)
  if (samples.reduce((sum, sample) => sum + sample.length, 0) > 120_000) {
    throw new DataAccessError(400, 'STYLE_SAMPLE_TOO_LARGE', '一次保存的样章合计不能超过 12 万字符。')
  }
  const contentHash = sha256([
    ...chapters.map((chapter) => `${chapter.id}:${chapter.revision}:${sha256(chapter.content)}`),
    ...(input.uploadedFile ? [`upload:${input.uploadedFile.name}:${input.uploadedFile.size}:${sha256(uploadedSample)}`] : []),
  ].join('|'))
  const passages = splitPassages(samples)
  const save = async (tx: Prisma.TransactionClient) => {
    const source = await tx.corpusSource.create({
      data: {
        userId: input.userId,
        novelId: input.novelId,
        scope: 'novel',
        name: input.title,
        sourceClass: 'author_private',
        rightsHolder: input.userId,
        license: 'Author-Owned-Private',
        commercialUse: true,
        redistribution: false,
        modification: true,
        rawStorageAllowed: true,
        indexAllowed: true,
        rightsStatus: 'approved',
        rightsEvidence: '作者在当前作品内主动选择自有章节或上传自有 TXT/Markdown 样章，并明确同意生成私有 Style DNA；不得跨作者或跨作品召回。',
        auditNote: '作者自有内容，仅限本作品。',
        auditedAt: new Date(),
      },
    })
    const document = await tx.corpusDocument.create({
      data: {
        userId: input.userId,
        novelId: input.novelId,
        sourceId: source.id,
        title: input.title,
        authorName: input.userId,
        contentHash,
        rawStorageAllowed: true,
        indexAllowed: true,
        status: 'indexed',
        metadata: {
          privateSamples: [
            ...chapters.filter(chapter => chapter.content.trim()).map(chapter => ({ name: chapter.title, content: chapter.content.trim() })),
            ...(input.uploadedFile ? [{ name: input.uploadedFile.name, content: uploadedSample }] : []),
          ],
          chapters: chapters.map((chapter) => ({ id: chapter.id, revision: chapter.revision, title: chapter.title })),
          uploadedFile: input.uploadedFile ? { name: input.uploadedFile.name, size: input.uploadedFile.size } : null,
        },
        passages: {
          create: passages.map((passage, ordinal) => ({
            userId: input.userId,
            novelId: input.novelId,
            ordinal,
            content: passage,
            contentHash: sha256(passage),
            charCount: normalizeText(passage).length,
          })),
        },
      },
    })
    await tx.styleProfile.updateMany({
      where: { userId: input.userId, novelId: input.novelId, kind: 'author', confirmed: true },
      data: { confirmed: false },
    })
    const profile = await tx.styleProfile.create({
      data: {
        userId: input.userId,
        novelId: input.novelId,
        sourceId: source.id,
        documentId: document.id,
        kind: 'author',
        name: input.title,
        stats: stats as unknown as Prisma.InputJsonObject,
        sampleCount: stats.sampleCount,
        sampleChars: stats.sampleChars,
        contentHash,
        confirmed: true,
      },
    })
    return { source, document, profile }
  }
  const result = transaction ? await save(transaction) : await prisma.$transaction(save)
  return { profileId: result.profile.id, sourceId: result.source.id, documentId: result.document.id, stats }
}

export async function getAuthorStyleProfile(userId: string, novelId: string, respectDataControl = false, db: Prisma.TransactionClient = prisma) {
  await assertOwnedNovel(userId, novelId, db)
  if (respectDataControl) {
    const dataControl = await db.agentDataControl.findUnique({ where: { userId_novelId: { userId, novelId } }, select: { privateStyleEnabled: true } })
    if (dataControl?.privateStyleEnabled === false) return null
  }
  return db.styleProfile.findFirst({
    where: { userId, novelId, kind: 'author', confirmed: true },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, sourceId: true, name: true, stats: true, sampleCount: true, sampleChars: true, contentHash: true, updatedAt: true },
  })
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value)
  const tokens = new Set<string>()
  for (const word of value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2)) tokens.add(word)
  for (let index = 0; index < normalized.length - 1; index += 1) tokens.add(normalized.slice(index, index + 2))
  return [...tokens]
}

function hashVector(value: string): number[] {
  const vector = Array.from({ length: HASH_VECTOR_SIZE }, () => 0)
  for (const token of tokenize(value)) {
    const digest = createHash('sha256').update(token).digest()
    const index = digest.readUInt16BE(0) % HASH_VECTOR_SIZE
    vector[index] += digest[2] % 2 === 0 ? 1 : -1
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1
  return vector.map((item) => item / magnitude)
}

function cosine(left: number[], right: number[]): number {
  return left.reduce((sum, item, index) => sum + item * (right[index] ?? 0), 0)
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

type SearchCard = Awaited<ReturnType<typeof loadSearchCards>>[number]

async function loadSearchCards(userId: string, novelId: string, db: Prisma.TransactionClient = prisma) {
  const now = new Date()
  return db.techniqueCard.findMany({
    where: {
      active: true,
      source: {
        rightsStatus: 'approved',
        indexAllowed: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      OR: [
        { userId: null, novelId: null },
        { userId, novelId: null },
        { userId, novelId },
      ],
    },
    include: { source: { select: { sourceClass: true, rightsStatus: true } } },
    take: MAX_SEARCH_CANDIDATES,
    orderBy: [{ genre: 'asc' }, { sceneType: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

function bm25Scores(cards: SearchCard[], queryTokens: string[]): Map<string, number> {
  const documents = cards.map((card) => tokenize(card.searchableText))
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length)
  const result = new Map<string, number>()
  cards.forEach((card, index) => {
    const document = documents[index]
    const frequencies = new Map<string, number>()
    document.forEach((token) => frequencies.set(token, (frequencies.get(token) ?? 0) + 1))
    let score = 0
    for (const token of queryTokens) {
      const documentFrequency = documents.filter((candidate) => candidate.includes(token)).length
      const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const frequency = frequencies.get(token) ?? 0
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * document.length / Math.max(1, averageLength))
      score += idf * (frequency * 2.2) / Math.max(0.001, denominator)
    }
    result.set(card.id, score)
  })
  const max = Math.max(1, ...result.values())
  result.forEach((value, key) => result.set(key, value / max))
  return result
}

function metadataScore(card: SearchCard, query: CraftSearchQuery): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []
  if (card.genre.includes(query.genre) || query.genre.includes(card.genre)) { score += 0.34; reasons.push('题材匹配') }
  if (card.sceneType.includes(query.sceneType) || query.sceneType.includes(card.sceneType)) { score += 0.34; reasons.push('场景任务匹配') }
  if (query.relationshipStage && card.relationshipStage.includes(query.relationshipStage)) { score += 0.08; reasons.push('关系阶段匹配') }
  if (query.pointOfView && card.pointOfView.includes(query.pointOfView)) { score += 0.08; reasons.push('视角匹配') }
  if (query.narrativeDistance && card.narrativeDistance.includes(query.narrativeDistance)) { score += 0.06; reasons.push('叙事距离匹配') }
  if (query.pace && card.pace.includes(query.pace)) { score += 0.04; reasons.push('节奏匹配') }
  const defects = query.defectTargets.filter((target) => card.defectTargets.includes(target))
  if (defects.length > 0) { score += Math.min(0.18, defects.length * 0.07); reasons.push(`缺陷目标：${defects.join('、')}`) }
  return { score, reasons }
}

export async function searchCraftLibrary(input: {
  userId: string
  novelId: string
  runId: string
  query: CraftSearchQuery
}, db: Prisma.TransactionClient = prisma): Promise<{ traceId: string; cards: CraftTechniqueCardView[]; profile: { id: string; stats: unknown } | null }> {
  await assertOwnedNovel(input.userId, input.novelId, db)
  const [cards, profile] = await Promise.all([
    loadSearchCards(input.userId, input.novelId, db),
    getAuthorStyleProfile(input.userId, input.novelId, true, db),
  ])
  const queryText = [input.query.genre, input.query.subgenre, input.query.sceneType, input.query.relationshipStage, input.query.pointOfView, input.query.narrativeDistance, input.query.pace, input.query.readerPromise, ...input.query.defectTargets].filter(Boolean).join(' ')
  const queryTokens = tokenize(queryText)
  const queryVector = hashVector(queryText)
  const lexical = bm25Scores(cards, queryTokens)
  const ranked = cards.map((card) => {
    const metadata = metadataScore(card, input.query)
    const embedding = Math.max(0, cosine(queryVector, hashVector(card.searchableText)))
    const score = metadata.score * 0.55 + (lexical.get(card.id) ?? 0) * 0.25 + embedding * 0.2
    return { card, score, reasons: [...metadata.reasons, `混合检索 ${(score * 100).toFixed(0)}%`], vector: hashVector(card.searchableText) }
  }).sort((left, right) => right.score - left.score)

  const selected: typeof ranked = []
  while (selected.length < input.query.limit && selected.length < ranked.length) {
    const remaining = ranked.filter((candidate) => !selected.some((item) => item.card.id === candidate.card.id))
    const next = remaining.map((candidate) => {
      const redundancy = selected.length === 0 ? 0 : Math.max(...selected.map((item) => Math.max(0, cosine(candidate.vector, item.vector))))
      return { candidate, mmr: candidate.score * 0.78 - redundancy * 0.22 }
    }).sort((left, right) => right.mmr - left.mmr)[0]?.candidate
    if (!next) break
    selected.push(next)
  }

  const views: CraftTechniqueCardView[] = selected.map(({ card, score, reasons }) => ({
    id: card.id,
    title: card.title,
    genre: card.genre,
    sceneType: card.sceneType,
    readerEffect: card.readerEffect,
    techniques: readStringArray(card.techniques),
    avoid: readStringArray(card.avoid),
    styleStats: card.styleStats && typeof card.styleStats === 'object' && !Array.isArray(card.styleStats) ? card.styleStats as Record<string, unknown> : {},
    rights: { sourceClass: card.source.sourceClass, reversibleQuote: false },
    score: rounded(score),
    reasons,
  }))
  const trace = await db.retrievalTrace.create({
    data: {
      userId: input.userId,
      novelId: input.novelId,
      runId: input.runId,
      query: input.query as unknown as Prisma.InputJsonObject,
      candidateIds: ranked.slice(0, 20).map((item) => item.card.id),
      selected: views as unknown as Prisma.InputJsonArray,
      profileId: profile?.id ?? null,
    },
  })
  return { traceId: trace.id, cards: views, profile: profile ? { id: profile.id, stats: profile.stats } : null }
}

export async function readRetrievalTrace(userId: string, novelId: string, traceId: string, db: Prisma.TransactionClient = prisma) {
  await assertOwnedNovel(userId, novelId, db)
  const trace = await db.retrievalTrace.findFirst({ where: { id: traceId, userId, novelId } })
  if (!trace) throw new DataAccessError(404, 'RETRIEVAL_TRACE_NOT_FOUND', '检索记录不存在或不属于当前作品。')
  return trace
}

function ngrams(value: string, size = 8): Set<string> {
  const normalized = normalizeText(value)
  const result = new Set<string>()
  for (let index = 0; index <= normalized.length - size; index += 1) result.add(normalized.slice(index, index + size))
  return result
}

function ngramOverlap(left: string, right: string): number {
  const leftSet = ngrams(left)
  const rightSet = ngrams(right)
  if (leftSet.size === 0 || rightSet.size === 0) return 0
  let overlap = 0
  leftSet.forEach((item) => { if (rightSet.has(item)) overlap += 1 })
  return overlap / Math.max(1, Math.min(leftSet.size, rightSet.size))
}

export function longestCommonSubstringLength(leftValue: string, rightValue: string): number {
  const left = normalizeText(leftValue)
  const right = normalizeText(rightValue)
  let low = 0
  let high = Math.min(left.length, right.length)
  const containsCommon = (length: number): boolean => {
    if (length === 0) return true
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
    const chunks = new Set<string>()
    for (let index = 0; index <= shorter.length - length; index += 1) chunks.add(shorter.slice(index, index + length))
    for (let index = 0; index <= longer.length - length; index += 1) if (chunks.has(longer.slice(index, index + length))) return true
    return false
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (containsCommon(middle)) low = middle
    else high = middle - 1
  }
  return low
}

export async function checkStyleLeakage(input: {
  userId: string
  novelId: string
  runId?: string | null
  chapterId?: string | null
  content: string
}, db: Prisma.TransactionClient = prisma): Promise<LeakageCheckView> {
  await assertOwnedNovel(input.userId, input.novelId, db)
  if (input.chapterId && !await db.chapter.findFirst({ where: { id: input.chapterId, novelId: input.novelId, authorId: input.userId }, select: { id: true } })) {
    throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '检查目标章节不存在或不属于当前作品。')
  }
  const outputHash = sha256(input.content)
  const passages = await db.corpusPassage.findMany({
    where: {
      document: {
        status: 'indexed',
        indexAllowed: true,
        source: {
          rightsStatus: 'approved',
          indexAllowed: true,
          sourceClass: { not: 'author_private' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        OR: [{ userId: null, novelId: null }, { userId: input.userId }, { novelId: input.novelId }],
      },
    },
    select: { id: true, content: true, contentHash: true },
    take: MAX_LEAKAGE_PASSAGES,
    orderBy: { createdAt: 'desc' },
  })
  let best = { passageId: null as string | null, passageHash: '', overlap: 0, lcs: 0, semantic: 0 }
  const outputVector = hashVector(input.content)
  for (const passage of passages) {
    const overlap = ngramOverlap(input.content, passage.content)
    const lcs = longestCommonSubstringLength(input.content, passage.content)
    const semantic = Math.max(0, cosine(outputVector, hashVector(passage.content)))
    const risk = overlap * 0.45 + Math.min(1, lcs / 100) * 0.4 + semantic * 0.15
    const bestRisk = best.overlap * 0.45 + Math.min(1, best.lcs / 100) * 0.4 + best.semantic * 0.15
    if (risk > bestRisk) best = { passageId: passage.id, passageHash: passage.contentHash, overlap, lcs, semantic }
  }
  const blocked = best.lcs >= 80 || best.overlap >= 0.48 || (best.lcs >= 40 && best.overlap >= 0.18) || (best.semantic >= 0.985 && best.lcs >= 24)
  const action = blocked ? '阻断自动写入；要求脱离来源措辞重新生成' : '允许写入'
  const check = await db.leakageCheck.create({
    data: {
      userId: input.userId,
      novelId: input.novelId,
      runId: input.runId ?? null,
      chapterId: input.chapterId ?? null,
      outputHash,
      matchedPassageId: best.passageId,
      ngramOverlap: rounded(best.overlap),
      longestCommonSubstring: best.lcs,
      semanticSimilarity: rounded(best.semantic),
      decision: blocked ? 'blocked' : 'passed',
      action,
      evidenceHash: best.passageId ? sha256(`${outputHash}:${best.passageHash}:${rounded(best.overlap)}:${best.lcs}:${rounded(best.semantic)}`) : null,
    },
  })
  return {
    id: check.id,
    decision: check.decision,
    ngramOverlap: check.ngramOverlap,
    longestCommonSubstring: check.longestCommonSubstring,
    semanticSimilarity: check.semanticSimilarity,
    action: check.action,
  }
}

export async function assertCraftOutputSafe(input: Parameters<typeof checkStyleLeakage>[0], db: Prisma.TransactionClient = prisma): Promise<LeakageCheckView> {
  const result = await checkStyleLeakage(input, db)
  if (result.decision === 'blocked') {
    throw new DataAccessError(409, 'STYLE_LEAKAGE_BLOCKED', `检测到可识别复写风险（最长连续重合 ${result.longestCommonSubstring} 字），本次未写入。请保留技法、完全重写措辞后重试。`)
  }
  return result
}

export async function createCorpusSource(adminId: string, input: CorpusSourceCreate) {
  return prisma.corpusSource.create({
    data: {
      scope: 'platform',
      name: input.name,
      sourceClass: input.sourceClass,
      rightsHolder: input.rightsHolder,
      sourceUrl: input.sourceUrl ?? null,
      license: input.license,
      commercialUse: input.commercialUse,
      redistribution: input.redistribution,
      modification: input.modification,
      rawStorageAllowed: input.rawStorageAllowed,
      indexAllowed: input.indexAllowed,
      rightsStatus: 'pending',
      rightsEvidence: input.evidence,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      auditNote: `待管理员 ${adminId} 复核。`,
    },
  })
}

export async function importCorpusDocument(input: {
  adminId: string
  sourceId: string
  document: CorpusDocumentImport
}): Promise<AdminCorpusDocumentImportResult> {
  const source = await prisma.corpusSource.findUnique({ where: { id: input.sourceId } })
  if (!source) throw new DataAccessError(404, 'CORPUS_SOURCE_NOT_FOUND', '语料来源不存在。')
  if (source.sourceClass === 'author_private') {
    throw new DataAccessError(409, 'PRIVATE_SOURCE_IMPORT_FORBIDDEN', '作者私有样章只能由作者在作品技能区授权。')
  }
  if (source.rightsStatus !== 'approved') {
    throw new DataAccessError(409, 'CORPUS_SOURCE_NOT_APPROVED', '来源尚未通过权利审批，不能导入生产语料。')
  }
  if (source.expiresAt && source.expiresAt <= new Date()) {
    await prisma.corpusSource.update({ where: { id: source.id }, data: { rightsStatus: 'expired', indexAllowed: false } })
    throw new DataAccessError(409, 'CORPUS_RIGHTS_EXPIRED', '来源授权已经到期，不能继续导入。')
  }
  if (!source.commercialUse || !source.rawStorageAllowed || !source.indexAllowed) {
    throw new DataAccessError(409, 'CORPUS_IMPORT_RIGHTS_INSUFFICIENT', '来源必须明确允许商业使用、原文存储和索引后才能导入。')
  }
  const content = input.document.content.trim()
  const contentHash = sha256(content)
  const duplicate = await prisma.corpusDocument.findUnique({
    where: { sourceId_contentHash: { sourceId: source.id, contentHash } },
    select: { id: true },
  })
  if (duplicate) throw new DataAccessError(409, 'CORPUS_DOCUMENT_DUPLICATE', '该文档已经导入，无需重复写入。')
  const passages = splitPassages([content])
  if (passages.length === 0) throw new DataAccessError(400, 'CORPUS_DOCUMENT_TOO_SHORT', '文档缺少可用正文段落。')
  const stats = extractStyleStats([content])
  return prisma.$transaction(async (tx) => {
    const document = await tx.corpusDocument.create({
      data: {
        sourceId: source.id,
        title: input.document.title,
        authorName: input.document.authorName || null,
        contentHash,
        rawStorageAllowed: true,
        indexAllowed: true,
        status: 'indexed',
        metadata: { ...input.document.metadata, importedByAdminId: input.adminId },
        passages: {
          create: passages.map((passage, ordinal) => ({
            ordinal,
            content: passage,
            contentHash: sha256(passage),
            charCount: normalizeText(passage).length,
          })),
        },
      },
    })
    const profile = await tx.styleProfile.create({
      data: {
        sourceId: source.id,
        documentId: document.id,
        kind: 'corpus',
        name: `${input.document.title} · 统计画像`,
        stats,
        sampleCount: 1,
        sampleChars: stats.sampleChars,
        contentHash,
        confirmed: true,
      },
    })
    return { documentId: document.id, passageCount: passages.length, styleProfileId: profile.id, contentHash }
  })
}

export async function verifyCorpusSource(input: { adminId: string; sourceId: string; decision: 'approved' | 'rejected'; auditNote: string }) {
  const source = await prisma.corpusSource.findUnique({ where: { id: input.sourceId } })
  if (!source) throw new DataAccessError(404, 'CORPUS_SOURCE_NOT_FOUND', '语料来源不存在。')
  if (source.sourceClass === 'author_private') throw new DataAccessError(409, 'PRIVATE_SOURCE_SELF_APPROVED', '作者私有样章由明确授权流程管理，不能在公共来源后台审批。')
  if (input.decision === 'approved') {
    if (!source.commercialUse || !source.indexAllowed) throw new DataAccessError(409, 'CORPUS_RIGHTS_INSUFFICIENT', '来源未明确允许商业使用和生产索引，不能批准。')
    if (!isWhitelistedPublicLicense(source.sourceClass, source.license)) {
      throw new DataAccessError(409, 'CORPUS_LICENSE_NOT_WHITELISTED', '公版或宽松许可来源必须使用已审核白名单许可证；其他权利安排请登记为商业授权。')
    }
    if (source.expiresAt && source.expiresAt <= new Date()) throw new DataAccessError(409, 'CORPUS_RIGHTS_EXPIRED', '来源授权已经到期，不能批准。')
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.corpusSource.update({
      where: { id: source.id },
      data: {
        rightsStatus: input.decision,
        auditedByUserId: input.adminId,
        auditedAt: new Date(),
        auditNote: input.auditNote,
        revokedAt: null,
      },
    })
    await tx.techniqueCard.updateMany({ where: { sourceId: source.id }, data: { active: input.decision === 'approved' } })
    await tx.corpusDocument.updateMany({
      where: { sourceId: source.id },
      data: { status: input.decision === 'approved' && source.rawStorageAllowed ? 'indexed' : 'blocked' },
    })
    return updated
  })
}

export async function listCorpusSources() {
  return prisma.corpusSource.findMany({
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, name: true, sourceClass: true, rightsHolder: true, sourceUrl: true, license: true, rightsEvidence: true,
      commercialUse: true, redistribution: true, modification: true, rawStorageAllowed: true,
      indexAllowed: true, rightsStatus: true, expiresAt: true, auditedAt: true, auditNote: true, createdAt: true, updatedAt: true,
      _count: { select: { documents: true, techniqueCards: true, styleProfiles: true } },
    },
  })
}

export async function revokeCorpusSource(input: { actorUserId: string; sourceId: string; novelId?: string; admin: boolean; reason: string }) {
  const source = await prisma.corpusSource.findUnique({ where: { id: input.sourceId } })
  if (!source) throw new DataAccessError(404, 'CORPUS_SOURCE_NOT_FOUND', '语料来源不存在。')
  if (!input.admin && (source.userId !== input.actorUserId || source.sourceClass !== 'author_private' || source.novelId !== input.novelId)) {
    throw new DataAccessError(403, 'CORPUS_SOURCE_FORBIDDEN', '无权撤回该语料来源。')
  }
  if (source.id === 'builtin.agent3.craft.v1') throw new DataAccessError(409, 'BUILTIN_SOURCE_LOCKED', '内置技法卡不能通过撤回接口删除。')
  return prisma.$transaction(async (tx) => {
    const [documents, passages, cards, profiles] = await Promise.all([
      tx.corpusDocument.count({ where: { sourceId: source.id } }),
      tx.corpusPassage.count({ where: { document: { sourceId: source.id } } }),
      tx.techniqueCard.count({ where: { sourceId: source.id } }),
      tx.styleProfile.count({ where: { sourceId: source.id } }),
    ])
    await tx.leakageCheck.updateMany({ where: { matchedPassage: { document: { sourceId: source.id } } }, data: { matchedPassageId: null } })
    await tx.corpusPassage.deleteMany({ where: { document: { sourceId: source.id } } })
    await tx.techniqueCard.deleteMany({ where: { sourceId: source.id } })
    await tx.styleProfile.deleteMany({ where: { sourceId: source.id } })
    await tx.corpusDocument.updateMany({ where: { sourceId: source.id }, data: { status: 'revoked', revokedAt: new Date(), indexAllowed: false, metadata: {} } })
    await tx.corpusSource.update({ where: { id: source.id }, data: { rightsStatus: 'revoked', revokedAt: new Date(), indexAllowed: false } })
    const deletedCounts = { documents, passages, techniqueCards: cards, styleProfiles: profiles, caches: 0 }
    const receiptHash = sha256(`${source.id}:${Date.now()}:${JSON.stringify(deletedCounts)}:${input.reason}`)
    return tx.corpusDeletionReceipt.create({
      data: {
        userId: source.userId,
        novelId: source.novelId,
        sourceId: source.id,
        deletedCounts,
        reason: input.reason,
        receiptHash,
      },
    })
  })
}
