import type { AgentQuestionPrompt } from './agent-events.js'

export function buildCoverSelectionQuestion(images: ReadonlyArray<{ id: string }>): AgentQuestionPrompt {
  return {
    question: images.length === 1 ? '要将这张候选图设为作品封面吗？' : '要将哪张候选图设为作品封面？',
    options: [
      ...images.map(({ id }, index) => ({ label: `应用候选封面 ${index + 1}`, coverAssetId: id })),
      { label: '暂不应用' },
    ],
  }
}
