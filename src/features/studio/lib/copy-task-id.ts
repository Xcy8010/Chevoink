import type { ToastContextValue } from '@/components/ui/toast-context'
import { copyToClipboard } from '@/lib/clipboard'

export const COPY_TASK_ID_LABEL = '复制任务 ID'
export const UNSAVED_TASK_ID_HINT = '新对话发出第一条消息后才有任务 ID'

export async function copyStudioTaskId(taskId: string, toast: Pick<ToastContextValue, 'success' | 'error'>) {
  if (await copyToClipboard(taskId)) {
    toast.success('任务 ID 已复制，可在对话里让 Agent 读取该任务的上下文。')
  } else {
    toast.error('复制失败，请手动选择文本复制。')
  }
}
