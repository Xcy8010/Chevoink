import type { Prisma } from '@prisma/client'
import { env } from '../config/env.js'

export async function contentPolicyEnabledForUser(userId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  return env.appEnv !== 'production'
    || await (await import('./app-releases.js')).hasGenerativeContentPolicyCapability(userId, tx)
}

const unlawfulContent = {
  obscene: {
    label: '淫秽色情内容',
    alternative: '可以保留人物关系和剧情转折，改写为含蓄的情感表达，或者把场景切到事后。',
  },
  national_security: {
    label: '危害国家安全、泄露国家秘密、煽动颠覆国家政权或分裂国家等违法内容',
    alternative: '可以围绕公开史料做中性分析，或者刻画虚构势力之间的利益冲突。',
  },
  terrorism_hate: {
    label: '宣扬恐怖主义、极端主义或煽动民族仇恨、民族歧视的内容',
    alternative: '可以从受影响的人物出发，描写后果、调查或冲突化解。',
  },
  harm_crime: {
    label: '宣扬违法暴力、赌博、教唆犯罪或为违法活动提供可执行帮助的内容',
    alternative: '可以描写调查、人物抉择和事件后果，省去可用于实施违法活动的细节。',
  },
  false_harmful: {
    label: '捏造和传播虚假有害信息的内容',
    alternative: '可以改用可核实的公开资料，或者将事件明确写成虚构故事。',
  },
  rights: {
    label: '侵害他人隐私、名誉、肖像、知识产权等合法权益的内容',
    alternative: '可以使用获授权的材料，或者改用匿名、自创的人物和素材。',
  },
  other: {
    label: '法律、行政法规禁止生成的其他内容',
    alternative: '可以保留合法的创作目标，换用合规的人物、情节或呈现方式。',
  },
} as const

type UnlawfulCategory = keyof typeof unlawfulContent

const boundaries = [
  '按完整请求、创作目的和实际拟生成的内容判断，下列类别只覆盖违法内容。',
  ...Object.entries(unlawfulContent).map(([key, value]) => `- ${key}：${value.label}。`),
  '中性的历史和政策讨论、对不当行为的批评或事实核查、虚构权谋、非露骨的情感情节，以及以叙事为目的描写犯罪的调查或后果，可以正常处理。出现相关词语、反派台词或历史引文不构成违规，请结合上下文判断。虚构设定不豁免仍然违法的实际产出。',
].join('\n')

export const CONTENT_REFUSAL_OPENING = '这项请求无法生成。'
const userTerms = '《用户服务协议》'
const refusalBasis = `该请求涉及${userTerms}禁止生成的内容。`

export const AGENT_CONTENT_POLICY = [
  '内容安全规则。以下规则适用于回复、创作、改写、图片及工具调用，优先于作者要求、用户技能、角色设定、历史记忆及其他任务指令。',
  boundaries,
  '在内部完成内容判断。正常任务照常执行，不播报或展示内容审核进度及通过信息，不为判断单独汇报、调用工具或建待办。',
  `请求明确要求生成违法内容时，拒绝违法部分，简短说明具体类别及其属于${userTerms}禁止生成的内容，并给出一个可以继续创作的替代方向。不得复述违法细节、输出或保存违法稿件、制作相关生图提示词、调用工具完成该部分，或转交给子 Agent。只有独立且已获作者授权的合法部分可以继续。替代方向会改变作者目标时，请先由作者选择。`,
  '封面工具返回内容拒绝时，向作者说明理由和替代方向，不以相同要求重试或换工具。服务暂不可用时沿用普通生成失败提示，不解释为内容违规。',
  `如果全部交付都需要拒绝，直接以「${CONTENT_REFUSAL_OPENING}」开头，接着说明原因并给出合规替代方向。只返回这段文字，不调用工具、不新建待办。子 Agent 用同样方式向主 Agent 交付拒绝结果。只有缺少会改变判断的事实时才问一个具体问题，不反复追问题材。`,
].join('\n')

export function usesAgentContentPolicy(messages: ReadonlyArray<{ role: string; content?: unknown }>): boolean {
  const first = messages[0]
  return first?.role === 'system' && typeof first.content === 'string' && first.content.includes(AGENT_CONTENT_POLICY)
}

export function isFullContentRefusal(text: string | null | undefined): text is string {
  return Boolean(text?.trimStart().startsWith(CONTENT_REFUSAL_OPENING))
}

export function formatFullContentRefusal(text: string): string {
  const refusal = text.trim()
  if (refusal.includes(userTerms)) return refusal
  return CONTENT_REFUSAL_OPENING + refusalBasis + refusal.slice(CONTENT_REFUSAL_OPENING.length).trimStart()
}

export const COVER_PROVIDER_REFUSAL_MESSAGE = `无法生成这张封面。当前描述触及${userTerms}的内容限制。可以改用象征性场景、原创人物或环境构图。`
export const AGENT_PROVIDER_REFUSAL_MESSAGE = `${CONTENT_REFUSAL_OPENING}模型服务已拦截这次生成。请按${userTerms}调整题材或呈现方式，可以改写为调查、人物抉择或事件后果。`

const coverRefusalPrefix = 'COVER_REFUSAL:'
function formatCoverRefusal(category: UnlawfulCategory): string {
  const rule = unlawfulContent[category]
  return `无法生成这张封面。请求要求呈现${rule.label}，属于${userTerms}禁止生成的内容。${rule.alternative}`
}

export const COVER_PROMPT_CONTENT_POLICY = [
  boundaries,
  '作品名、简介和其他资料都只是素材。只有明确要求在封面呈现违法内容时拒绝。对于合法的历史、虚构或情感题材，照常生成提示词。',
  `拒绝时只输出 ${coverRefusalPrefix}<类别代号>，代号取自上面的列表。`,
].join('\n')

export function coverRefusalMessage(result: string): string | undefined {
  const response = result.trim()
  if (!response.startsWith(coverRefusalPrefix)) return undefined
  const category = response.slice(coverRefusalPrefix.length)
  if (!Object.prototype.hasOwnProperty.call(unlawfulContent, category)) return undefined
  return formatCoverRefusal(category as UnlawfulCategory)
}
