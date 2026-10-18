import { createHash } from 'node:crypto'
import type { NovelImportEvidencePreview } from '../../../shared/contracts/novel-import-preview.js'
import { NOVEL_IMPORT_LIMITS } from '../../../shared/contracts/novel-import.js'
import type { ImportClassificationResult, ImportClassificationSources } from '../../../shared/contracts/novel-import-classification.js'
import { DataAccessError } from '../prisma.js'
import { classificationSnapshot, validateImportClassification } from './classification-validation.js'

const changed = (): never => { throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_STALE', '分类来源或预览已变化，未应用结果，请刷新。') }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const key = (location: ImportClassificationSources['sources'][number]['location']) => JSON.stringify(location)
const sourceKey = (source: ImportClassificationSources['sources'][number]['source']) => JSON.stringify(source && Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))

/** Pure reference-only projection. Service MUST lock/fence the job and successful
 * classification row, verify ownership/expiry, then bump revision + persistPreview.
 * skip isolates the full source, NEVER certifying OCR/report completeness.
 * No title/content is supplied by the model; existing source metadata is retained.
 */
export function applyImportClassification<T extends NovelImportEvidencePreview>(old: T, result: ImportClassificationResult): T {
  if (old.manifestRevision !== result.manifestRevision || old.manifestHash !== result.manifestHash) changed()
  const content = new Map<string, { title: string; content: string; source?: ImportClassificationSources['sources'][number]['source'] }>()
  old.volumes.forEach((v, vi) => v.chapters.forEach((c, ci) => content.set(key({ kind: 'chapter', volumeIndex: vi, chapterIndex: ci }), c)))
  old.plans?.forEach((p, index) => content.set(key({ kind: 'plan', index }), p))
  old.memories?.forEach((m, index) => content.set(key({ kind: 'memory', index }), m))
  old.classificationSkipped?.forEach((m, index) => content.set(key({ kind: 'skipped', index }), m))
  const seen = new Set<string>()
  const sources = result.sourceProofs.map(proof => {
    const locationKey = key(proof.location)
    let text: string
    let source = proof.source
    if (proof.location.kind === 'artifact') {
      const descriptor = old.artifacts?.find(a => a.url.endsWith(`/artifacts/${proof.artifactId}`))
      const reportItem = descriptor && old.report?.items.find(item => item.artifactId === descriptor.id)
      if (!reportItem) changed()
      text = reportItem!.text ?? ''
    } else {
      const item = content.get(locationKey)
      if (!item || seen.has(locationKey)) changed()
      seen.add(locationKey)
      text = item!.content
      source = item!.source
    }
    if (hash(text) !== proof.textHash || text.length !== proof.characters || text.slice(proof.excerpt.start, proof.excerpt.start + proof.excerpt.text.length) !== proof.excerpt.text || sourceKey(source) !== sourceKey(proof.source)) changed()
    if (proof.location.kind !== 'artifact' && content.get(locationKey)!.title !== proof.title) changed()
    return { ...proof, ...(source ? { source } : {}) }
  })
  if (seen.size !== content.size) changed()
  for (const artifact of result.artifacts) {
    const descriptor = old.artifacts?.find(a => a.url.endsWith(`/artifacts/${artifact.artifactId}`))
    if (!descriptor || descriptor.sha256 !== artifact.sha256 || descriptor.coverCandidate !== artifact.coverCandidate) changed()
  }
  const snapshot: ImportClassificationSources = { manifestRevision: old.manifestRevision, manifestHash: old.manifestHash, complete: true, sources, artifacts: result.artifacts }
  if (classificationSnapshot(snapshot).snapshotHash !== result.snapshotHash) changed()
  if (result.classifications.length !== sources.length || new Set(result.classifications.map(c => c.sourceId)).size !== sources.length) changed()
  const validated = result.classifications.map(decision => {
    const proof = sources.find(s => s.sourceId === decision.sourceId)
    if (!proof) changed()
    const { reason, ...entry } = decision
    if (!['classified', 'uncertain', 'missing_source', 'unclassified_budget'].includes(reason) || reason === 'unclassified_budget' && entry.category !== 'skip') changed()
    const value = validateImportClassification({ classifications: [entry], cover: null }, { ...snapshot, sources: [proof!] }).classifications[0]
    return { ...value, reason: reason === 'unclassified_budget' ? reason : value.reason }
  })
  const decisions = new Map(validated.map(c => [c.sourceId, c.category]))
  const byLocation = new Map(sources.map(s => [key(s.location), decisions.get(s.sourceId)!]))
  const next = structuredClone(old)
  next.volumes = old.volumes.map((v, vi) => ({ ...structuredClone(v), chapters: v.chapters.filter((_c, ci) => byLocation.get(key({ kind: 'chapter', volumeIndex: vi, chapterIndex: ci })) === 'chapter').map(c => structuredClone(c)) }))
  next.plans = (old.plans ?? []).filter((_p, index) => byLocation.get(key({ kind: 'plan', index })) === 'plan').map(p => structuredClone(p))
  next.memories = (old.memories ?? []).flatMap((m, index) => {
    const category = byLocation.get(key({ kind: 'memory', index }))!
    return category === 'characterCard' || category === 'worldbuilding' || category === 'storyBible' ? [{ ...structuredClone(m), memoryType: category }] : []
  })
  next.classificationSkipped = []
  // Iterate original locations, not model response order, for deterministic order.
  for (const [location, item] of content) {
    const category = byLocation.get(location)!
    const original = sources.find(s => key(s.location) === location)!.location.kind
    if (category === 'skip') {
      const proof = sources.find(s => key(s.location) === location)!
      next.classificationSkipped.push({ ...structuredClone(item), reason: validated.find(c => c.sourceId === proof.sourceId)!.reason })
      continue
    }
    if (category === original || original === 'memory' && ['characterCard', 'worldbuilding', 'storyBible'].includes(category)) continue
    if (!item.source) changed()
    const preserved = { title: item.title, content: item.content, source: structuredClone(item.source!) }
    if (category === 'chapter') {
      if (!next.volumes.length) next.volumes.push({ title: '导入章节', chapters: [] })
      next.volumes[next.volumes.length - 1].chapters.push(preserved)
    } else if (category === 'plan') next.plans.push(preserved)
    else if (category === 'characterCard' || category === 'worldbuilding' || category === 'storyBible') next.memories.push({ ...preserved, memoryType: category })
    else changed()
  }
  if (result.cover) {
    const proof = sources.find(s => s.sourceId === result.cover!.sourceId)
    const decision = result.classifications.find(c => c.sourceId === result.cover!.sourceId)
    if (!proof || !decision) changed()
    const { reason: _reason, ...entry } = decision!
    const cover = validateImportClassification({ classifications: [entry], cover: result.cover }, { ...snapshot, sources: [proof!] }).cover
    if (!cover) changed()
    const descriptor = old.artifacts!.find(a => a.url.endsWith(`/artifacts/${cover!.artifactId}`))!
    // Existing preview/commit uses the parser descriptor ID, not the DB ID.
    next.metadataSelection = { ...next.metadataSelection, coverArtifactId: descriptor.id }
  }
  if (next.classificationSkipped.length) next.partialImport = true
  next.volumes = next.volumes.filter(volume => volume.chapters.length > 0)
  const chapters = next.volumes.flatMap(volume => volume.chapters)
  if (next.volumes.length > NOVEL_IMPORT_LIMITS.volumes || chapters.length > NOVEL_IMPORT_LIMITS.chapters
    || chapters.some(chapter => !chapter.title.trim() || chapter.title.length > 128 || chapter.content.length > NOVEL_IMPORT_LIMITS.chapterCharacters)
    || next.plans.length > 200 || next.memories.length > 500
    || [...next.plans, ...next.memories].some(item => !item.title.trim() || item.title.length > 160 || item.content.length > NOVEL_IMPORT_LIMITS.characters)) {
    throw new DataAccessError(413, 'IMPORT_LIMIT_EXCEEDED', '分类后的章节标题/正文长度或计划、设定数量超过导入上限；未截断原文，未应用结果，请手动调整。')
  }
  return next
}
