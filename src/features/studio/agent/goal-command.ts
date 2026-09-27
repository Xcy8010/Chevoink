import type { CreditModelTier, ModelReasoningEffort } from '../../../../shared/contracts/credits.js'

export type GoalCommand =
  | { kind: 'ordinary' }
  | { kind: 'enable'; body: string }
  | { kind: 'control'; action: 'edit' | 'pause' | 'resume' | 'clear' }
  | { kind: 'invalid'; message: string }

const actions = { edit: 'edit', 修改: 'edit', pause: 'pause', 暂停: 'pause', resume: 'resume', 继续: 'resume', clear: 'clear', 取消: 'clear' } as const

/** Leading, independent token only. Never interpret quoted/code/attachment content as controls. */
export function parseGoalCommand(text: string, composing = false): GoalCommand {
  if (composing) return { kind: 'ordinary' }
  const match = /^(?:\/goal|\/目标)(?=\s|$)/i.exec(text)
  if (!match) return { kind: 'ordinary' }
  const body = text.slice(match[0].length).replace(/^\s+/, '')
  const first = /^(\S+)([\s\S]*)$/.exec(body)
  if (first) {
    const action = actions[first[1].toLowerCase() as keyof typeof actions]
    if (action) return first[2].trim() ? { kind: 'invalid', message: '请单独使用目标操作，或通过修改目标保存正文。' } : { kind: 'control', action }
  }
  return { kind: 'enable', body }
}

/** Goal actions use the same effective tier as an ordinary run and never carry a stale BYOK id. */
export function buildGoalResumeModel(modelTier: CreditModelTier, customModelId: string | null, reasoningEffort: ModelReasoningEffort) {
  const effectiveTier = modelTier === 'basic' ? 'speed' : modelTier
  return {
    modelTier: effectiveTier,
    ...(effectiveTier === 'custom' && customModelId ? { customModelId } : {}),
    reasoningEffort,
  }
}
