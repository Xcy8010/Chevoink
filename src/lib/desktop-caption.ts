import { createContext } from 'react'

/** Native caption slot for the active route's toolbar. */
export const DesktopCaptionHost = createContext<HTMLElement | null>(null)

export const captionWaitingForLogo = 'data-desktop-caption-waiting-for-logo'
export const captionLogoFinished = 'data-desktop-caption-logo-finished'
