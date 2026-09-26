import { auxiliaryTextModel } from './auxiliary-text-model.js'
import { generateTextCompletion } from '../ai-service.js'
import { prisma } from '../prisma.js'

/**
 * 会话自动命名：用户首次对话且会话仍是默认标题时，让模型生成 6-12 字标题（仅一次）。
 * 命名成功后标题不再匹配默认模式，后续 run 不会重复触发。
 */

/** 默认标题判定：创建接口的 `xxx 写作会话` 与前端占位 `新任务` 均视为未命名 */
export function isDefaultSessionTitle(title: string): boolean {
  const normalized = title.trim()
  return !normalized || normalized === '新任务' || normalized.includes('写作会话')
}

function sanitizeGeneratedTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/["'“”‘’《》【】[\]（）()<>]/g, '')
    .replace(/^(标题|命名|名称)[:：]\s*/, '')
    .replace(/[，。！？、,.!?:：；;\s]+$/g, '')
    .trim()
}

export async function autoNameSession(input: {
  sessionId: string
  userId: string
  novelId: string
  prompt: string
  modelRuntime?: import('./tools/types.js').ToolContext['modelRuntime']
}): Promise<void> {
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: input.sessionId },
      select: { id: true, title: true },
    })

    if (!session || !isDefaultSessionTitle(session.title)) {
      return
    }

    let title = ''
    try {
      const generated = await generateTextCompletion(
        '你是对话命名助手。根据用户的写作诉求，生成一个 6-12 个字的中文标题概括这次任务。只输出标题本身，不要引号、标点或任何解释。',
        input.prompt.slice(0, 500),
        {
          userId: input.userId,
          modelRuntime: auxiliaryTextModel(input.modelRuntime),
          action: 'agentSessionAutoName',
          novelId: input.novelId,
          targetType: 'agentSession',
          targetId: input.sessionId,
          temperature: 0.3,
        },
      )
      title = sanitizeGeneratedTitle(generated)
    } catch {
      title = ''
    }

    // 模型不可用时降级：直接取用户诉求的前 12 字
    if (!title) {
      title = sanitizeGeneratedTitle(input.prompt).slice(0, 12)
    }

    if (!title || title.length < 2) {
      return
    }

    // Compare-and-set: a user/tool rename during generation wins atomically.
    await prisma.agentSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, novelId: input.novelId, title: session.title },
      data: { title: title.slice(0, 20) },
    })
  } catch (error) {
    console.error('[agent-loop] 会话自动命名失败', input.sessionId, error)
  }
}
