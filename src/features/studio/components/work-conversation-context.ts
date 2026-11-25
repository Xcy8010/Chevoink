import { createContext, useContext } from 'react'

export type ConversationLoadPhase = 'ready' | 'pending' | 'skeleton'

export const WorkConversationContext = createContext<{
  collapsed: boolean
  expand: () => void
  activityDock?: 'expanded' | 'collapsed'
  setConversationLoadPhase?: (phase: ConversationLoadPhase) => void
}>({ collapsed: false, expand: () => {} })
export const useWorkConversation = () => useContext(WorkConversationContext)
