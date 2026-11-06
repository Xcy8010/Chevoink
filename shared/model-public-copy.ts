/** Public writing guidance, independent of provider names and upstream model IDs. */
export const BUILTIN_MODEL_PUBLIC_COPY = {
  lite: { description: '把零散想法变成创作起点，适合构思灵感、整理素材和尝试不同表达。', features: ['灵感发散', '素材整理', '简单改写'] },
  speed: { description: '让思路顺畅落到文字里，适合情节构思、段落续写和日常修改。', features: ['情节构思', '段落续写', '日常修改'] },
  standard: { description: '兼顾故事结构与文字表达，适合章节起草、内容梳理和日常润色。', features: ['章节起草', '结构梳理', '文字润色'] },
  performance: { description: '把人物与情节想得更细，适合推敲动机、衔接线索和打磨关键场景。', features: ['人物塑造', '情节推演', '细节打磨'] },
  ultimate: { description: '为重要篇章仔细推敲，适合复杂情节规划、多方案比较和集中修订。', features: ['情节规划', '多方案比较', '重点修订'] },
}

/** Empty catalog copy uses the writing guidance; configured public copy stays editable. */
export function modelPublicCopy(tier: string | null | undefined, value: unknown) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const defaults = tier && Object.prototype.hasOwnProperty.call(BUILTIN_MODEL_PUBLIC_COPY, tier) ? BUILTIN_MODEL_PUBLIC_COPY[tier as keyof typeof BUILTIN_MODEL_PUBLIC_COPY] : undefined
  const description = typeof metadata.publicDescription === 'string' ? metadata.publicDescription.trim() : ''
  const features = Array.isArray(metadata.publicFeatures) ? metadata.publicFeatures.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
  return { publicDescription: description || defaults?.description || '', publicFeatures: features.length ? features : [...(defaults?.features ?? [])] }
}
