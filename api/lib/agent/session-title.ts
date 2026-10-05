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
  return !normalized || normalized === '新任务' || /^.+ 写作会话$/.test(normalized)
}

function sanitizeGeneratedTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/["'“”‘’《》【】[\]（）()<>]/g, '')
    .replace(/^(标题|命名|名称)[:：]\s*/, '')
    .replace(/[，。！？、,.!?:：；;\s]+$/g, '')
    .trim()
}

/** A local task summary is also used by admission paths that never call a model. */
export function fallbackSessionTitle(prompt: string): string {
  const lines = prompt.replace(/未命名作品/g, '').split(/[\r\n]+/).map(line => line.trim())
  const request = lines.filter(line => /^(?:请|帮我|帮忙|麻烦|接下来|根据|参考|对|把|为|继续|续写|写|完成|润色|修订|修改|分析|检查|审阅|总结|规划|设计|整理|创建|生成)/.test(line)).at(-1) ?? ''
  const chapterPattern = /第[一二三四五六七八九十百千万零〇两\d]{1,6}章/
  const chapter = request.match(chapterPattern)?.[0] ?? lines.join(' ').match(chapterPattern)?.[0]
  const action = /续写|继续/.test(request) ? '续写' : /润色/.test(request) ? '润色'
    : /修订|修改|重写/.test(request) ? '修订' : /检查|审阅/.test(request) ? '检查'
      : /分析/.test(request) ? '分析' : /规划|设计/.test(request) ? '规划'
        : /创作|写|完成|生成|创建/.test(request) ? '创作' : '整理'
  const writing = ['续写', '润色', '修订', '创作'].includes(action)
  const topic = chapter ?? (request.match(/章节|人物|设定|大纲|书名|封面/)?.[0])
  const title = topic ? `${action}${topic}${writing && chapter ? '正文' : '任务'}` : `${action}作品写作任务`
  return Array.from(title).length <= 12 ? title : `${action}章节写作任务`
}

function generatedSessionTitle(raw: string, prompt: string): string | null {
  // Reject a prose response before cleanup can turn it into a title-shaped prefix.
  if (/[\r\n#`]/.test(raw.trim())) return null
  const title = sanitizeGeneratedTitle(raw)
  const length = Array.from(title).length
  if (prompt.includes(title) && !/续写|创作|写作|润色|修订|修改|分析|检查|审阅|总结|规划|设计|整理|创建|生成|优化|完善|补写/.test(title)) return null
  return length >= 6 && length <= 12 && !title.includes('未命名作品') && !/[，。！？、,.!?:：；;]/.test(title) ? title : null
}

export async function autoNameSession(input: {
  sessionId: string
  userId: string
  novelId: string
  prompt: string
  modelRuntime?: import('./tools/types.js').ToolContext['modelRuntime']
  signal?: AbortSignal
}): Promise<void> {
  try {
    const session = await prisma.agentSession.findFirst({
      where: { id: input.sessionId, userId: input.userId, novelId: input.novelId },
      select: { id: true, title: true },
    })

    if (!session || !isDefaultSessionTitle(session.title)) {
      return
    }

    let title = ''
    try {
      const generated = await generateTextCompletion(
        '你是对话命名助手。根据作者要求执行的动作和对象，生成一个 6-12 个字的中文标题概括这次任务。参考正文不是任务标题，不要照抄正文或 Markdown 标题，不要使用占位作品名“未命名作品”。只输出标题本身，不要引号、标点或任何解释。',
        input.prompt.length <= 500 ? input.prompt : `${input.prompt.slice(0, 200)}\n${input.prompt.slice(-299)}`,
        {
          userId: input.userId,
          signal: input.signal,
          modelRuntime: auxiliaryTextModel(input.modelRuntime),
          action: 'agentSessionAutoName',
          novelId: input.novelId,
          targetType: 'agentSession',
          targetId: input.sessionId,
          temperature: 0.3,
        },
      )
      title = generatedSessionTitle(generated, input.prompt) ?? ''
    } catch {
      title = ''
    }

    // Invalid/model-unavailable replies still describe the task, never a prose prefix.
    if (!title) {
      title = fallbackSessionTitle(input.prompt)
    }

    if (!title || title.length < 2) {
      return
    }

    // Compare-and-set: a user/tool rename during generation wins atomically.
    await prisma.agentSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, novelId: input.novelId, title: session.title },
      data: { title },
    })
  } catch (error) {
    console.error('[agent-loop] 会话自动命名失败', input.sessionId, error)
  }
}
