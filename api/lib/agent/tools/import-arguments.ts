import { z } from 'zod'

const attachmentUrl = z.string().min(1).max(1024)
const jobId = z.string().uuid()

export const novelImportArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), attachmentUrl }).strict(),
  z.object({ action: z.literal('status'), jobId }).strict(),
  z.object({ action: z.literal('commit'), jobId }).strict(),
])

// Some providers reject root unions in tool definitions. The model sees the
// action guide, and the server still enforces the exact union above.
export const novelImportModelArguments = z.strictObject({
  action: z.enum(['prepare', 'status', 'commit']),
  attachmentUrl: attachmentUrl.optional().describe('仅 prepare 必填。使用本轮上传附件的真实 URL。'),
  jobId: jobId.optional().describe('仅 status 或 commit 必填。使用服务端返回的导入任务 ID。'),
})
