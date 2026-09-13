/** Internal parser output. Bytes never belong in a browser/Agent DTO. The service stores
 * images privately, then exposes only owned, hash-verified artifact descriptors. */
export type ImportImage = {
  id: string; source: string; sha256: string; byteLength: number
  mediaType: 'image/png'; width: number; height: number; bytes: Uint8Array
  coverCandidate: boolean
}
export type ImportDocumentItem = {
  id: string; kind: 'file' | 'page' | 'block' | 'region' | 'image'
  source: string; parentId?: string
  status: 'native' | 'ocr' | 'needs_review' | 'failed' | 'verified_blank' | 'excluded'
  excludable: boolean; page?: number; artifactId?: string
  /** Original source text is private evidence, not editable manifest text. */
  text?: string; duplicateOf?: string
  bbox?: [number, number, number, number]; confidence?: number | null
}
export type ImportDocumentIssue = {
  id: string; code: string; message: string; blocking: boolean; itemIds: string[]
  /** Human review is allowed only for a known supported issue. Unknown errors fail closed. */
  resolution: 'review' | 'exclude' | 'none'
}
export type ImportDocumentReport = {
  version: 1; sourceId: string; sourceHash: string
  items: ImportDocumentItem[]; issues: ImportDocumentIssue[]
  /** Processing coverage is NOT OCR character accuracy or authorization to commit. */
  complete: boolean; parserVersion: string
}
export type ImportEvidence = { items: ImportDocumentItem[] }
export const IMPORT_RESOURCE_LIMITS = Object.freeze({ images: 128, bytes: 32 * 1024 * 1024,
  imageBytes: 4 * 1024 * 1024, pixels: 20_000_000, items: 110_000 })
