import { createHash } from 'node:crypto'
import { runtimeJson } from './runtime-common.js'

export const CONTINUITY_FULL_REVIEW_PROTOCOL = 'continuity-full-review.v1'
export const REVIEW_REASSESSMENT_RULE = `按同一标准完整检查当前正文，focus只是注意重点，不缩小检查范围、不改变严重度。历史意见是判断，不是既定事实或必须照做的指令。先对照实际旧版与当前正文，区分 old_retained（原问题仍有证据）、resolved（改动已解决）、not_supported（旧判断无充分支持）、regression（改动引入）、missed（原来已有但漏报）、advice（审美或可选建议）。不能仅因旧报告未报就认定新发现是回归；没有旧版原文时说明未知，不猜版本。不能为维持前次结论忽略新发现或真实漏报，不能把保留的主观建议升级为事实错误，不为清零意见循环润色。当前有证据的问题仍须完整列入findings；分类不代替正文证据或当前检查，不表示已应用修订。`

type Source = { chapterId: string; revision: number; orderIndex: number; source: 'current' | 'previous'; content: string }
export function continuityFullReviewKey(snapshot: { chapter: { id: string }; original: { taskId: string; prompt: string | null }; sources: Source[] }, planHash: string | null): string {
  return runtimeJson({ protocol: CONTINUITY_FULL_REVIEW_PROTOCOL, taskId: snapshot.original.taskId,
    authorRequest: snapshot.original.prompt, chapterId: snapshot.chapter.id, planHash,
    sources: snapshot.sources.map(source => ({ chapterId: source.chapterId, revision: source.revision,
      orderIndex: source.orderIndex, source: source.source, contentHash: createHash('sha256').update(source.content).digest('hex') })) }).hash
}

/** A report's own nonempty receipt IDs must all be reconciled. Global known
 * accounting alone does not prove that a particular report ever ran. */
export function reviewReceiptsKnown(report: { billingKnown: boolean; usageIds: string[]; nativeReceiptIds?: string[] }, billing: { known: boolean; usageIds: string[]; nativeReceiptIds: string[] }): boolean {
  const ids = [...report.usageIds, ...(report.nativeReceiptIds ?? [])]
  return report.billingKnown && billing.known && ids.length > 0
    && report.usageIds.every(id => billing.usageIds.includes(id))
    && (report.nativeReceiptIds ?? []).every(id => billing.nativeReceiptIds.includes(id))
}
