import { createContext, useContext } from 'react'

export const WorkConversationContext = createContext<{
  collapsed: boolean
  expand: () => void
  activityDock?: 'expanded' | 'collapsed'
}>({ collapsed: false, expand: () => {} })
export const useWorkConversation = () => useContext(WorkConversationContext)
