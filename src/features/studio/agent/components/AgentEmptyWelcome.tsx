import { BookPlus, Compass, Layers3, Sparkles, UsersRound } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'

import { useAgentStore } from '../agentStore'

type Props = {
  novelName: string
  initializingNovel?: boolean
  seed: string
  showSuggestions?: boolean
  mobile?: boolean
}

const NOVEL_GENRES = ['玄幻', '都市悬疑', '古代言情', '科幻', '仙侠', '历史架空', '现代言情', '末日生存']

const CREATE_PROMPTS = [
  '帮我从一句灵感开始，设计主角、核心冲突和世界观',
  '帮我规划一部节奏紧凑、开篇有强钩子的长篇小说',
  '根据当下网文读者偏好，给我三个原创题材方向',
  '帮我设计一组有张力的人物关系和长期矛盾',
  '从零搭建故事大纲，并规划前三章的关键推进',
  '帮我把脑海里的零散设定整理成一部完整小说',
]

const BUILD_PROMPTS = [
  '检查现有设定，找出逻辑冲突并给出修订方案',
  '为下一章设计三个可推进主线的场景方向',
  '梳理主要人物关系，并补全缺失的动机',
  '优化作品简介和标签，让定位更清晰',
  '检查最近章节的节奏、连续性和人物表现',
  '根据现有正文规划下一卷的核心矛盾',
  '帮我设计一个自然但有冲击力的剧情转折',
  '把当前计划细化成可以直接写作的章节任务',
  '分析这部作品最值得强化的卖点',
  '为主要角色补充独特声口和行为习惯',
]

const CARD_ICONS = [BookPlus, Compass, UsersRound, Layers3] as const

function hashSeed(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededShuffle(values: string[], seed: string) {
  const result = [...values]
  let state = hashSeed(seed) || 1
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const target = state % (index + 1)
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

export default function AgentEmptyWelcome({ novelName, initializingNovel = false, seed, showSuggestions = true, mobile = false }: Props) {
  const setComposerDraft = useAgentStore((state) => state.setComposerDraft)
  const suggestions = useMemo(() => {
    if (initializingNovel) {
      const genre = NOVEL_GENRES[hashSeed(`${seed}:genre`) % NOVEL_GENRES.length]
      return [`帮我创建一部${genre}类型的小说`, ...seededShuffle(CREATE_PROMPTS, `${seed}:create`).slice(0, 3)]
    }
    return seededShuffle(BUILD_PROMPTS, `${seed}:build`).slice(0, 4)
  }, [initializingNovel, seed])

  return (
    <div data-agent-welcome={mobile ? 'mobile' : 'desktop'} className={cn('mx-auto flex w-full flex-col items-center px-1 text-center', mobile ? 'max-w-[440px] shrink-0 py-5' : 'h-full max-w-[760px] justify-center py-6 sm:px-4')}>
      <img
        src="/chevoink-agent.png"
        alt="Chevoink Agent"
        className={cn('rounded-[14px] object-contain', mobile ? 'h-10 w-10' : 'h-12 w-12 sm:h-14 sm:w-14')}
      />
      <h2 className={cn('text-balance font-semibold tracking-[-0.02em] text-[var(--text-primary)]', mobile ? 'mt-4 text-lg' : 'mt-5 text-lg sm:text-[22px]')}>
        {initializingNovel
          ? '你可以让 Chevoink Agent 帮你做些什么？'
          : `你想让我们在《${novelName}》构建什么？`}
      </h2>
      <p className="mt-2 max-w-[560px] text-xs leading-5 text-[var(--text-secondary)] sm:text-sm">
        {showSuggestions ? '选择一个方向作为起点，内容只会填入输入框，你可以继续修改后再发送。' : '在下方输入任务，Agent 会结合当前作品和已打开的章节继续工作。'}
      </p>
      {showSuggestions ? <div className={cn('grid w-full', mobile ? 'mt-5 grid-cols-1 gap-2.5' : 'mt-6 grid-cols-1 gap-2.5 sm:grid-cols-2')}>
        {(mobile ? suggestions.slice(0, 3) : suggestions).map((suggestion, index) => {
          const Icon = CARD_ICONS[index] ?? Sparkles
          return (
            <button
              key={suggestion}
              type="button"
              onClick={() => setComposerDraft(suggestion)}
              className={cn('group flex items-start rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] text-left transition-[border-color,background-color,transform] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)] motion-reduce:transition-none', mobile ? 'min-h-14 min-w-0 items-center gap-3 rounded-[24px] px-4 py-3 active:scale-[0.99]' : 'min-h-[74px] gap-3 px-4 py-3 hover:-translate-y-px')}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text-primary)]" />
              <span className={cn('break-words text-xs font-medium text-[var(--text-primary)]', mobile ? 'leading-[1.65]' : 'leading-5 sm:text-[13px]')}>{suggestion}</span>
            </button>
          )
        })}
      </div> : null}
    </div>
  )
}
