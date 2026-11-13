import type { ComponentProps } from 'react'

import AppState from '@/components/ui/AppState'
import type { ChevoinkMascotPose } from '@/components/ui/ChevoinkMascot'

type EmptyStateScene = 'shelf' | 'messages' | 'works' | 'search' | 'comments' | 'generic'
type AppStateProps = ComponentProps<typeof AppState>

type EmptyStateProps = Pick<AppStateProps, 'className' | 'compact' | 'description' | 'icon'> & {
  scene?: EmptyStateScene
  title?: string
  action?: AppStateProps['primaryAction']
}

const sceneDefaults: Record<EmptyStateScene, { pose: ChevoinkMascotPose; title: string; description?: string }> = {
  shelf: { pose: 'reading', title: '书架还空着', description: '去发现页挑一本书。' },
  messages: { pose: 'message', title: '还没有消息' },
  works: { pose: 'writing', title: '还没有作品' },
  search: { pose: 'search', title: '没有匹配的内容', description: '换个关键词试试。' },
  comments: { pose: 'welcome', title: '还没有评论' },
  generic: { pose: 'reading', title: '这里还没有内容' },
}

export default function EmptyState({ scene = 'generic', title, description, action, ...props }: EmptyStateProps) {
  const defaults = sceneDefaults[scene]
  return (
    <AppState
      {...props}
      scene={defaults.pose}
      title={title ?? defaults.title}
      description={description ?? defaults.description}
      primaryAction={action}
    />
  )
}
