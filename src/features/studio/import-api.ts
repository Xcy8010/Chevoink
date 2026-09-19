import type { NovelImportCapabilities, NovelImportJobStatus, NovelImportManifestEdit, NovelImportModelSelection, NovelImportPreflight, NovelImportPreview, NovelImportReceipt, NovelImportRestorePreview, NovelImportRestoreReceipt } from '../../../shared/contracts/novel-import.js'
import { requestData } from './api'

const root = (novelId: string) => `/api/novels/${encodeURIComponent(novelId)}/imports`
const jobPath = (novelId: string, jobId: string) => `${root(novelId)}/${encodeURIComponent(jobId)}`
const json = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export const novelImportApi = {
  capabilities: (novelId: string) => requestData<NovelImportCapabilities>(`${root(novelId)}/capabilities`),
  list: (novelId: string) => requestData<NovelImportJobStatus[]>(root(novelId)),
  preflight: (novelId: string, origin?: { runId: string; callId: string }) => requestData<NovelImportPreflight>(`${root(novelId)}/preflight`, json('POST', origin ? { origin } : undefined)),
  confirmSelectionIntent: (novelId: string, intent: NovelImportPreflight) => requestData<NovelImportPreflight>(`${root(novelId)}/intents/${encodeURIComponent(intent.intentId)}/confirm-selection`, json('POST', { targetHash: intent.targetHash, confirmed: true })),
  confirmIntent: (novelId: string, intent: NovelImportPreflight, step: 1 | 2) => requestData<NovelImportPreflight>(`${root(novelId)}/intents/${encodeURIComponent(intent.intentId)}/confirm`, json('POST', { step, targetHash: intent.targetHash })),
  create: (novelId: string, intentId: string, modelSelection: NovelImportModelSelection, replaceUnfinished = false) => requestData<NovelImportJobStatus>(root(novelId), json('POST', { intentId, modelSelection, ...(replaceUnfinished ? { replaceUnfinished: true } : {}) })),
  upload: (novelId: string, jobId: string, file: File) => requestData<NovelImportJobStatus>(`${jobPath(novelId, jobId)}/source?filename=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file, timeoutMs: 120_000 }),
  attachment: (novelId: string, jobId: string, attachment: { url: string; runId: string }) => requestData<NovelImportJobStatus>(`${jobPath(novelId, jobId)}/attachment`, json('POST', { url: attachment.url, runId: attachment.runId })),
  analyze: (novelId: string, jobId: string, encoding?: string, reparse = false) => requestData<NovelImportJobStatus>(`${jobPath(novelId, jobId)}/analyze`, { ...json('POST', { ...(encoding ? { encoding } : {}), ...(reparse ? { reparse: true } : {}) }), timeoutMs: 120_000 }),
  retry: (novelId: string, jobId: string, encoding?: string) => requestData<NovelImportJobStatus>(`${jobPath(novelId, jobId)}/retry`, { ...json('POST', encoding ? { encoding } : {}), timeoutMs: 120_000 }),
  status: (novelId: string, jobId: string) => requestData<NovelImportJobStatus>(jobPath(novelId, jobId)),
  preview: (novelId: string, jobId: string) => requestData<NovelImportPreview>(`${jobPath(novelId, jobId)}/preview`),
  edit: (novelId: string, jobId: string, edit: NovelImportManifestEdit) => requestData<NovelImportPreview>(`${jobPath(novelId, jobId)}/manifest`, json('PATCH', edit)),
  rebase: (novelId: string, jobId: string, intentId: string) => requestData<NovelImportJobStatus>(`${jobPath(novelId, jobId)}/rebase`, json('POST', { intentId })),
  confirm: (novelId: string, job: NovelImportJobStatus, preview: Pick<NovelImportPreview, 'manifestRevision' | 'manifestHash'>) => requestData<{ approvalId: string; expiresAt: string }>(`${jobPath(novelId, job.jobId)}/confirm`, json('POST', { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: job.targetHash })),
  commit: (novelId: string, jobId: string, approvalId: string, idempotencyKey: string) => requestData<NovelImportReceipt>(`${jobPath(novelId, jobId)}/commit`, json('POST', { approvalId, idempotencyKey })),
  cancel: (novelId: string, jobId: string) => requestData<NovelImportJobStatus>(`${jobPath(novelId, jobId)}/cancel`, json('POST')),
  restorePreview: (novelId: string, jobId: string) => requestData<NovelImportRestorePreview>(`${jobPath(novelId, jobId)}/restore-preview`),
  restoreConfirm: (novelId: string, jobId: string, targetHash: string) => requestData<{ restoreApprovalId: string; targetHash: string; expiresAt: string }>(`${jobPath(novelId, jobId)}/restore-confirm`, json('POST', { targetHash })),
  restore: (novelId: string, jobId: string, approval: { restoreApprovalId: string; targetHash: string }) => requestData<NovelImportRestoreReceipt>(`${jobPath(novelId, jobId)}/restore`, json('POST', { restoreApprovalId: approval.restoreApprovalId, targetHash: approval.targetHash, idempotencyKey: `novel-import-restore:${jobId}` })),
}

export type NovelImportClient = typeof novelImportApi
