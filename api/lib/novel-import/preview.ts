import type { z } from 'zod'
import { NOVEL_IMPORT_LIMITS, type NovelImportPreview } from '../../../shared/contracts/novel-import.js'
import type { NovelImportDocumentReport, NovelImportEvidencePreview, NovelImportReportDto, NovelImportReportItem, novelImportReviewSchema, novelImportStructureSchema } from '../../../shared/contracts/novel-import-preview.js'
import { DataAccessError } from '../prisma.js'
import { importBytesHash } from '../novel-import-storage.js'

const reject = (code: string, message: string): never => { throw new DataAccessError(409, code, message) }
/** 计划/创作记忆段落也算有效导入内容：仅导入设定或计划时不应被“至少一章正文”闸拒绝。 */
export const routedContentCount = (preview: { plans?: unknown[]; memories?: unknown[] }) => (preview.plans?.length ?? 0) + (preview.memories?.length ?? 0)
export const reportHash = (report: NovelImportDocumentReport) => importBytesHash(JSON.stringify(report))
export const canonicalPreviewHash = (value: unknown) => importBytesHash(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item))
export const previewContentHash = (preview: NovelImportPreview) => canonicalPreviewHash(preview.volumes)
export const chapterSource = (source: NovelImportPreview['volumes'][number]['chapters'][number]['source']) => (source.memberPath ?? source.filename ?? '').replace(/#char=\d+-\d+$/, '')
const withinSource = (child: string, parent: string) => child === parent || child.startsWith(`${parent}#`) || child.startsWith(`${parent}&`) || child.startsWith(`${parent}!/`)
const COVERAGE_SUMMARIES = new Set(['IMPORT_NATIVE_COVERAGE', 'IMPORT_NATIVE_INCOMPLETE_CONTENT'])

function evidence(preview: NovelImportEvidencePreview) {
  if (!preview.report || !preview.reportHash || preview.reportHash !== reportHash(preview.report) || preview.report.sourceHash !== preview.sourceHash || preview.report.parserVersion !== preview.parserVersion) reject('IMPORT_REPORT_UNAVAILABLE', '来源报告缺失或校验失败，请重新解析。')
  const report = preview.report!
  const items = new Map(report.items.map(item => [item.id, item]))
  if (items.size !== report.items.length || new Set(report.issues.map(issue => issue.id)).size !== report.issues.length || report.issues.some(issue => issue.itemIds.some(id => !items.has(id)))) reject('IMPORT_REPORT_INVALID', '来源报告的项目引用无效。')
  for (const item of report.items) {
    const visited = new Set([item.id]); let parentId = item.parentId
    while (parentId) {
      if (visited.has(parentId) || !items.has(parentId)) reject('IMPORT_REPORT_INVALID', '来源报告的层级引用无效。')
      visited.add(parentId); parentId = items.get(parentId)!.parentId
    }
  }
  return { report, items }
}
function itemCovered(item: NovelImportReportItem, selected: NovelImportReportItem, items: Map<string, NovelImportReportItem>): boolean {
  if (item.id === selected.id) return true
  let parent = item.parentId
  while (parent) { if (parent === selected.id) return true; parent = items.get(parent)?.parentId }
  return ['file', 'page'].includes(selected.kind) && withinSource(item.source, selected.source)
}
function resolutionState(preview: NovelImportEvidencePreview, boundContentHash?: string) {
  const { report, items } = evidence(preview)
  const contentHash = boundContentHash ?? previewContentHash(preview)
  const decisions = preview.decisions ?? []
  const excludes = decisions.filter(d => d.action === 'exclude' && d.sourceHash === preview.sourceHash && d.reportHash === preview.reportHash && items.get(d.itemId)?.excludable).map(d => items.get(d.itemId)!)
  const excluded = (item: NovelImportReportItem) => excludes.some(selected => itemCovered(item, selected, items))
  const reviewed = (id: string) => decisions.some(d => d.action === 'review' && d.itemId === id && d.sourceHash === preview.sourceHash && d.reportHash === preview.reportHash && d.contentHash === contentHash)
  const issues = report.issues.map(issue => ({ ...issue, resolved: !issue.blocking || (issue.itemIds.length > 0 && issue.resolution !== 'none' && issue.itemIds.every(id => {
    const item = items.get(id)!
    return excluded(item) || (issue.resolution === 'review' && item.status !== 'failed' && reviewed(id))
  })) }))
  // Known aggregate coverage summaries are derived from EACH physical item.
  // Excluding a failed page must not also require excluding healthy pages.
  // Unknown summary/error codes never receive this derived resolution.
  for (const issue of issues) if (issue.blocking && COVERAGE_SUMMARIES.has(issue.code)) {
    issue.resolved = issue.itemIds.length > 0 && issue.itemIds.every(id => {
      const item = items.get(id)!
      if (excluded(item)) return true
      if (item.status === 'failed' || (item.status === 'needs_review' && !reviewed(id))) return false
      return issues.filter(other => other.blocking && !COVERAGE_SUMMARIES.has(other.code) && other.itemIds.includes(id)).every(other => other.resolved)
    })
  }
  return { report, items, excluded, reviewed, issues }
}

export function assertPreviewCoverSelection(preview: NovelImportEvidencePreview): void {
  const selected = preview.metadataSelection.coverArtifactId
  if (!selected) return
  const image = preview.artifacts?.find(artifact => artifact.id === selected && artifact.coverCandidate)
  const state = resolutionState(preview)
  const sourceItems = state.report.items.filter(item => item.artifactId === selected || (image && item.source === image.source))
  if (!image || !sourceItems.length || sourceItems.some(item => state.excluded(item))) reject('IMPORT_COVER_INVALID', '封面必须是当前预览中未排除的图片候选，请先取消封面选择再排除来源。')
}

/** Authoritative confirmation/commit gate. Warning DTOs are never the evidence. */
export function assertNovelImportPreviewComplete(input: NovelImportPreview): void {
  const preview: NovelImportEvidencePreview = input
  assertPreviewCoverSelection(preview)
  const state = resolutionState(preview)
  if (state.issues.some(issue => !issue.resolved)) reject('IMPORT_INCOMPLETE_CONTENT', '来源报告还有未解决项目，请复核或明确排除。')
  for (const item of state.report.items) {
    if (state.excluded(item)) continue
    if (item.status === 'failed' || (item.status === 'needs_review' && !state.reviewed(item.id) && !state.issues.some(issue => issue.resolved && issue.itemIds.includes(item.id)))) reject('IMPORT_INCOMPLETE_CONTENT', '来源仍有未处理或待核验内容。')
  }
  if (!state.report.complete && !state.report.issues.some(issue => issue.blocking)) reject('IMPORT_INCOMPLETE_CONTENT', '来源覆盖报告不完整，请重新解析。')
  if (!preview.volumes.some(v => v.chapters.some(c => c.content.trim())) && !routedContentCount(preview)) reject('IMPORT_NO_BODY', '至少保留一章非空正文。')
  if (preview.volumes.some(v => v.chapters.some(c => c.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters))) reject('IMPORT_CHAPTER_TOO_LONG', '单章超过10万字符，请拆分。')
}

export function refreshPreviewWarnings(preview: NovelImportEvidencePreview): NovelImportEvidencePreview {
  assertPreviewCoverSelection(preview)
  const issues = resolutionState(preview).issues
  const warnings = issues.map(({ code, message, blocking, resolved }) => ({ code, message, blocking: blocking && !resolved }))
  // Keep informational service notices, but never trust caller-provided blocking flags.
  warnings.push(...preview.warnings.filter(w => w.code === 'IMPORT_EMPTY_VOLUMES_RETAINED').map(w => ({ code: w.code, message: w.message, blocking: false })))
  if (preview.volumes.some(v => v.chapters.some(c => c.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters))) warnings.push({ code: 'IMPORT_CHAPTER_TOO_LONG', message: '单章超过10万字符，请在预览中拆分。', blocking: true })
  return { ...preview, warnings, partialImport: (preview.decisions ?? []).some(d => d.action === 'exclude') }
}

export function previewReportDto(preview: NovelImportEvidencePreview, boundContentHash?: string): NovelImportReportDto {
  const state = resolutionState(preview, boundContentHash)
  return { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, sourceHash: preview.sourceHash, reportHash: preview.reportHash!, partialImport: !!preview.partialImport,
    items: state.report.items.map(({ text, ...item }) => ({ ...item, ...(text === undefined ? {} : { textHash: importBytesHash(text), characters: text.length }) })),
    issues: state.issues, decisions: preview.decisions ?? [], artifacts: preview.artifacts ?? [] }
}

export function applySourceReview(preview: NovelImportEvidencePreview, input: z.infer<typeof novelImportReviewSchema>): NovelImportEvidencePreview {
  if (input.expectedManifestRevision !== preview.manifestRevision || input.manifestHash !== preview.manifestHash || input.reportHash !== preview.reportHash) reject('IMPORT_PREVIEW_CHANGED', '预览或来源报告已变化，请重新核对。')
  const { report, items } = evidence(preview)
  if (new Set(input.decisions.map(d => d.itemId)).size !== input.decisions.length) reject('IMPORT_INPUT_INVALID', '同一来源不能重复提交决定。')
  const decisions = new Map((preview.decisions ?? []).map(d => [d.itemId, d]))
  const selected: NovelImportReportItem[] = []
  for (const decision of input.decisions) {
    const item = items.get(decision.itemId)
    if (!item) reject('IMPORT_INPUT_INVALID', '来源项目不存在。')
    if (decision.action === 'exclude') {
      if (!item!.excludable) reject('IMPORT_EXCLUSION_INVALID', '此来源不能直接排除。')
      // Text blocks cannot be dropped without exact source mapping. Choose their page/file.
      if (!['file', 'page'].includes(item!.kind) && item!.text?.length && preview.volumes.some(v => v.chapters.some(c => withinSource(item!.source, chapterSource(c.source))))) reject('IMPORT_EXCLUSION_INVALID', '此块无法独立定位正文，请选择所属整页或文件排除。')
      selected.push(item!)
    } else {
      if (decisions.get(item!.id)?.action === 'exclude') reject('IMPORT_EXCLUSION_INVALID', '已排除来源需要重新解析才能恢复。')
      const issues = report.issues.filter(issue => issue.blocking && !COVERAGE_SUMMARIES.has(issue.code) && issue.itemIds.includes(item!.id))
      if (item!.status === 'failed' || !issues.length || issues.some(issue => issue.resolution !== 'review')) reject('IMPORT_REVIEW_INVALID', '缺失或失败内容不能用已复核代替，请重新解析或明确排除。')
    }
    decisions.set(decision.itemId, { ...decision, sourceHash: preview.sourceHash, reportHash: preview.reportHash!, contentHash: '', reviewedAt: new Date().toISOString() })
  }
  const volumes = preview.volumes.map(v => ({ ...v, chapters: v.chapters.filter(c => !selected.some(item => withinSource(chapterSource(c.source), item.source))) }))
  if (!volumes.some(v => v.chapters.some(c => c.content.trim())) && !routedContentCount(preview)) reject('IMPORT_NO_BODY', '不能排除全部正文；至少保留一章非空正文。')
  const next: NovelImportEvidencePreview = { ...preview, volumes, decisions: [...decisions.values()] }
  const contentHash = previewContentHash(next)
  // Old review decisions are invalidated by body exclusion; new choices bind the actual result.
  next.decisions = next.decisions!.filter(d => d.action === 'exclude' || input.decisions.some(choice => choice.itemId === d.itemId) || d.contentHash === contentHash).map(d => input.decisions.some(choice => choice.itemId === d.itemId) ? { ...d, contentHash } : d)
  return refreshPreviewWarnings(next)
}

/** Range edits are server-built and must partition EVERY current chapter exactly once. */
export function applyStructureEdit(preview: NovelImportEvidencePreview, input: z.infer<typeof novelImportStructureSchema>): NovelImportEvidencePreview {
  if (input.expectedManifestRevision !== preview.manifestRevision || input.manifestHash !== preview.manifestHash) reject('IMPORT_PREVIEW_CHANGED', '预览已变化，请刷新目录。')
  const ranges = new Map<string, Array<[number, number]>>()
  let segments = 0; let chapters = 0
  const volumes = input.volumes.map(volume => ({ title: volume.title, chapters: volume.chapters.map(chapter => {
    if (++chapters > NOVEL_IMPORT_LIMITS.chapters) reject('IMPORT_LIMIT_EXCEEDED', '章节数量超过上限。')
    let sourceKey: string | undefined
    const content = chapter.segments.map(segment => {
      if (++segments > 8000) reject('IMPORT_LIMIT_EXCEEDED', '结构片段过多，请分批保存。')
      const origin = preview.volumes[segment.volumeIndex]?.chapters[segment.chapterIndex]
      if (!origin || segment.start > segment.end || segment.end > origin.content.length) reject('IMPORT_STRUCTURE_INVALID', '正文范围不属于当前预览。')
      const source = chapterSource(origin!.source)
      if (sourceKey !== undefined && sourceKey !== source) reject('IMPORT_STRUCTURE_INVALID', '只能合并同一来源的正文。')
      sourceKey = source
      // Do not split a UTF-16 surrogate pair into separately unrenderable chapters.
      for (const offset of [segment.start, segment.end]) if (offset > 0 && offset < origin!.content.length && /[\uD800-\uDBFF]/.test(origin!.content[offset - 1]) && /[\uDC00-\uDFFF]/.test(origin!.content[offset])) reject('IMPORT_STRUCTURE_INVALID', '拆分位置不能位于一个字符内部。')
      const key = `${segment.volumeIndex}:${segment.chapterIndex}`
      ranges.set(key, [...(ranges.get(key) ?? []), [segment.start, segment.end]])
      return origin!.content.slice(segment.start, segment.end)
    }).join('')
    if (content.length > NOVEL_IMPORT_LIMITS.characters) reject('IMPORT_LIMIT_EXCEEDED', '正文超过上限。')
    return { title: chapter.title, content, source: { memberPath: sourceKey! } }
  }) }))
  preview.volumes.forEach((volume, vi) => volume.chapters.forEach((chapter, ci) => {
    const parts = ranges.get(`${vi}:${ci}`) ?? []
    parts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let end = 0
    for (const part of parts) { if (part[0] !== end) reject('IMPORT_CONTENT_NOT_CONSERVED', '结构编辑重复或遗漏了原文；请使用来源排除操作删除内容。'); end = part[1] }
    if (!parts.length || end !== chapter.content.length) reject('IMPORT_CONTENT_NOT_CONSERVED', '结构编辑遗漏原文；请使用来源排除操作删除内容。')
  }))
  return refreshPreviewWarnings({ ...preview, volumes, metadataSelection: input.metadataSelection ?? preview.metadataSelection, decisions: (preview.decisions ?? []).filter(d => d.action === 'exclude') })
}

/** Compatibility guard for the old full-body PATCH. New clients should use ranges. */
export function assertLegacyContentConserved(before: NovelImportPreview, volumes: NovelImportPreview['volumes']): void {
  const group = (value: NovelImportPreview['volumes']) => {
    const map = new Map<string, string[]>()
    for (const volume of value) for (const chapter of volume.chapters) { const key = chapterSource(chapter.source); map.set(key, [...(map.get(key) ?? []), chapter.content]) }
    return map
  }
  const old = group(before.volumes); const next = group(volumes)
  if (old.size !== next.size) reject('IMPORT_CONTENT_NOT_CONSERVED', '来源正文不能由结构编辑添加或删除。')
  for (const [source, parts] of old) {
    const replacement = next.get(source)
    if (!replacement || (parts.join('') !== replacement.join('') && JSON.stringify([...parts].sort()) !== JSON.stringify([...replacement].sort()))) reject('IMPORT_CONTENT_NOT_CONSERVED', '结构编辑必须逐字保留原文；拆分重排请使用范围编辑。')
  }
}
