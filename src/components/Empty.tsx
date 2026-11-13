import type { ReactNode } from 'react'

import AppState from '@/components/ui/AppState'
import type { ChevoinkMascotPose } from '@/components/ui/ChevoinkMascot'

type EmptyProps = {
  title?: string
  description?: string
  details?: ReactNode
  scene?: ChevoinkMascotPose
}

export default function Empty({
  title = '这里暂时还没有内容',
  description,
  details,
  scene = 'reading',
}: EmptyProps) {
  return <AppState compact scene={scene} title={title} description={description} details={details} />
}
