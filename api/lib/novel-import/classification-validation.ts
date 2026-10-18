import { createHash } from 'node:crypto'
import { DataAccessError } from '../prisma.js'
import { importClassificationOutputSchema, importClassificationSourcesSchema, type ImportClassificationSources, type ImportClassificationDecision } from '../../../shared/contracts/novel-import-classification.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const invalid = (): never => { throw new DataAccessError(422, 'IMPORT_CLASSIFICATION_INVALID', '分类结果缺少完整来源或逐字证据，原文未修改，请手动分类。') }
export function classificationSnapshot(input: ImportClassificationSources) {
  const snapshot = importClassificationSourcesSchema.parse(input)
  snapshot.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  snapshot.artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId))
  if (new Set(snapshot.sources.map(s => s.sourceId)).size !== snapshot.sources.length || new Set(snapshot.sources.map(s => JSON.stringify(s.location))).size !== snapshot.sources.length || new Set(snapshot.artifacts.map(a => a.artifactId)).size !== snapshot.artifacts.length) invalid()
  if (snapshot.sources.some(s => s.artifactId && !snapshot.artifacts.some(a => a.artifactId === s.artifactId))) invalid()
  if (snapshot.sources.some(s => s.excerpt.start + s.excerpt.text.length > s.characters)) invalid()
  const sourceProofs = snapshot.sources
  return { snapshot, sourceProofs, snapshotHash: digest(JSON.stringify({ manifestRevision: snapshot.manifestRevision, manifestHash: snapshot.manifestHash, sourceProofs, artifacts: snapshot.artifacts })) }
}
export function validateImportClassification(value: unknown, input: ImportClassificationSources) {
  const parsed = importClassificationOutputSchema.safeParse(value)
  if (!parsed.success) invalid()
  const output = parsed.data!
  const { snapshot } = classificationSnapshot(input)
  const sources = new Map(snapshot.sources.map(s => [s.sourceId, s]))
  if (output.classifications.length !== sources.size || new Set(output.classifications.map(s => s.sourceId)).size !== sources.size) invalid()
  const verify = (id: string, evidence: Array<{ start: number; end: number; quote: string }>) => {
    const source = sources.get(id)
    if (!source) invalid()
    for (const e of evidence) if (e.start >= e.end || e.start < source!.excerpt.start || e.end > source!.excerpt.start + source!.excerpt.text.length || source!.excerpt.text.slice(e.start - source!.excerpt.start, e.end - source!.excerpt.start) !== e.quote) invalid()
    return source!
  }
  const classifications: ImportClassificationDecision[] = output.classifications.map(entry => {
    const source = verify(entry.sourceId, entry.evidence)
    // Evidence is mandatory for a positive decision. Low confidence is never
    // converted into a guess; retain the exact proof for human review.
    const missing = !source.source || !Object.keys(source.source).length
    if (entry.confidence < 0.85 || !entry.evidence.length || missing || source.location.kind === 'artifact') entry.category = 'skip'
    return { ...entry, reason: missing ? 'missing_source' : entry.category === 'skip' ? 'uncertain' : 'classified' }
  })
  if (output.cover) {
    const cover = output.cover
    const source = verify(cover.sourceId, cover.evidence)
    if (source.artifactId !== cover.artifactId || !snapshot.artifacts.some(a => a.artifactId === cover.artifactId && a.coverCandidate)) invalid()
    if (cover.confidence < 0.85 || !source.source || !Object.keys(source.source).length) output.cover = null
  }
  return { classifications, cover: output.cover }
}
