import type { StartAgentLoopRunRequest } from '../../../shared/contracts/index.js'
import type { ChatMessage } from '../ai-service.js'
import { readManagedImageDataUrl } from '../agent-attachment-storage.js'
import { DataAccessError } from '../prisma.js'

/** Keep a supplemental author's images on that message, not on the original goal. */
export async function buildGoalSteeringMessage(input: StartAgentLoopRunRequest, userId: string, visionEnabled: boolean): Promise<ChatMessage> {
  const attachments = input.attachments ?? []
  const images = attachments.filter(item => item.kind === 'image')
  const nativeImages = visionEnabled ? await Promise.all(images.map(item => readManagedImageDataUrl(item.url, userId))) : []
  if (nativeImages.some(item => !item)) throw new DataAccessError(409, 'GOAL_ATTACHMENT_UNAVAILABLE', '补充消息的图片无法读取，原消息已保留。')
  const text = [
    '[作者对当前目标的补充，不替换持久目标或扩大冻结权限]', input.prompt,
    ...(input.selection?.text ? [`作者本次选区：\n${input.selection.text}`] : []),
    ...attachments.map(item => `${item.kind === 'image' ? '图片' : '文件'} ${JSON.stringify(item.name)}：${item.url}`),
    ...(images.length ? [visionEnabled ? '本消息图片像素已随消息发送。' : '先调用 view_image 读取本消息的图片，再执行有关操作。'] : []),
    ...(attachments.some(item => item.kind === 'file') ? ['先调用 read_file 读取本消息的文件；导入仍需遵循来源与审批约束。'] : []),
  ].join('\n')
  return { role: 'user', content: nativeImages.length
    ? [{ type: 'text', text }, ...nativeImages.flatMap(url => url ? [{ type: 'image_url' as const, image_url: { url, detail: 'auto' as const } }] : [])]
    : text }
}
