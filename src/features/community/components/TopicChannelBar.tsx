import { cn } from '@/lib/utils'

export type CommunityTopic = {
  id: string
  name: string
}

type TopicChannelBarProps = {
  topics: CommunityTopic[]
  activeTopicId: string
  onChange: (topicId: string) => void
}

/** 话题频道导航（方案 8.3.1）：话题从附属属性提升为频道导航 */
export default function TopicChannelBar({
  topics,
  activeTopicId,
  onChange,
}: TopicChannelBarProps) {
  return (
    <nav className="rail-scroll flex h-11 items-center gap-1.5 px-3 [scroll-snap-type:none] md:px-1" aria-label="话题频道">
      {topics.map((topic) => {
        const isActive = topic.id === activeTopicId
        return (
          <button
            key={topic.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(topic.id)}
            className={cn(
              'press-feedback flex h-8 shrink-0 items-center rounded-full px-2.5 text-xs transition-colors md:text-sm',
              isActive
                ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]',
            )}
          >
            {topic.name}
          </button>
        )
      })}
    </nav>
  )
}
