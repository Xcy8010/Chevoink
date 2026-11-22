import { createContext } from 'react'

/** Native caption slot for the active route's toolbar. */
export const DesktopCaptionHost = createContext<HTMLElement | null>(null)
