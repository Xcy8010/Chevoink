import { createContext } from 'react'

/** A wide native window can host the real studio command bar alongside its caption controls. */
export const DesktopStudioCommands = createContext<HTMLElement | null>(null)
