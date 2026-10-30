import { useEffect, useRef, useState } from 'react'

/** Smooth only received live text. Completion and scope changes flush immediately. */
export function useStreamingText(text: string, streaming: boolean, identity: string) {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [visible, setVisible] = useState({ text, identity })
  const current = useRef(visible)
  const pending = useRef({ text, identity })
  const wasStreaming = useRef(streaming)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    pending.current = { text, identity }
    const started = streaming && !wasStreaming.current
    wasStreaming.current = streaming
    if (started || !streaming || reduced || current.current.identity !== identity || !text.startsWith(current.current.text)) {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      current.current = { text, identity }
      setVisible(current.current)
      return
    }
    const tick = () => {
      timer.current = null
      const target = pending.current
      const length = current.current.text.length
      let end = Math.min(target.text.length, length + Math.max(2, Math.ceil((target.text.length - length) / 3)))
      // Do not split an astral Unicode character between animation frames.
      if (end < target.text.length && /[\uD800-\uDBFF]/.test(target.text[end - 1])) end++
      current.current = { text: target.text.slice(0, end), identity: target.identity }
      setVisible(current.current)
      if (end < target.text.length) timer.current = setTimeout(tick, 16)
    }
    if (timer.current === null && current.current.text !== text) timer.current = setTimeout(tick, 16)
  }, [text, identity, streaming, reduced])
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null }, [])
  return !streaming || reduced || visible.identity !== identity || !text.startsWith(visible.text) ? text : visible.text
}
