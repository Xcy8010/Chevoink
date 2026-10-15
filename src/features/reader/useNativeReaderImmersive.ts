import { useEffect, useRef } from 'react'
import { enterNativeImmersive, exitNativeImmersive, isDarkColor, isNativeApp, syncNativeSystemBars } from '@/lib/native-app'
import { setNativeImmersiveSafeArea } from '@/lib/safe-area'

/** One lifecycle owns reading, comment-keyboard suspension and route cleanup. */
export function useNativeReaderImmersive(commentsOpen: boolean, background: string) {
  const color = useRef(background)
  color.current = background
  useEffect(() => {
    if (!isNativeApp()) return
    let current = true
    if (commentsOpen) {
      setNativeImmersiveSafeArea(false)
      void exitNativeImmersive().then(() => {
        if (current) syncNativeSystemBars(color.current, isDarkColor(color.current))
      })
    } else {
      void enterNativeImmersive().then(insets => {
        if (current && insets) setNativeImmersiveSafeArea(true, insets)
      })
    }
    return () => {
      // Ignore a late enter completion after comments open or the route leaves.
      current = false
      setNativeImmersiveSafeArea(false)
      void exitNativeImmersive()
    }
  }, [commentsOpen])

  useEffect(() => {
    syncNativeSystemBars(background, isDarkColor(background))
  }, [background])
}
