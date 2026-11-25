import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import artwork from '@/assets/studio-announcement.webp'
import paper from '@/assets/studio-notice-paper.webp'
import { useStudioDismiss } from '@/features/studio/components/use-studio-presence'
import './studio-announcement.css'

type Props = {
  item: { title: string; body: string }
  coverTitle: '最新公告' | '公告' | '个人通知'
  publishedAt: string
  onShown?: () => void
  invoker?: HTMLButtonElement | null
  onExitStart?: (viewHistory: boolean) => void
  onDismiss: () => void
  onHistory?: () => void
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
const inkDigits = '〇一二三四五六七八九'

function inkCalendarNumber(value: number) {
  if (value < 10) return inkDigits[value]
  if (value === 20) return '二十'
  const tens = ['', '十', '廿', '三十'][Math.floor(value / 10)]
  const ones = value % 10
  return tens + (ones ? inkDigits[ones] : '')
}

export default function StudioAnnouncementDialog({ item, coverTitle, publishedAt, onShown, onDismiss, onHistory, onExitStart, invoker }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cover = useRef<HTMLImageElement>(null)
  const titleId = useId()
  const destination = useRef<'close' | 'history' | null>(null)
  const shown = useRef(onShown)
  useLayoutEffect(() => { shown.current = onShown }, [onShown])
  const { dismiss, phase } = useStudioDismiss(() => {
    if (destination.current === 'history') onHistory?.()
    else onDismiss()
  })

  useEffect(() => {
    const node = dialog.current!
    let frame = 0
    let disposed = false
    let observer: MutationObserver | undefined
    let previous: HTMLElement | null = null
    function present() {
      if (disposed || node.open) return
      const otherDialog = !invoker && Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]'))
        .some(other => other !== node && (other.matches('dialog[open]') || other.getClientRects().length > 0))
      if (otherDialog) {
        if (!observer) {
          observer = new MutationObserver(present)
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'aria-modal', 'inert'] })
        }
        return
      }
      observer?.disconnect()
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      node.showModal()
      node.focus({ preventScroll: true })
      shown.current?.()
    }
    // Paint the workspace first, then reveal the illustrated dialog in one frame.
    const painted = () => { if (!disposed) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(present) }) }
    if (invoker) present()
    else if (cover.current?.decode) void cover.current.decode().then(painted, painted)
    else painted()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      if (!node.open) return
      node.close()
      const origin = invoker ?? previous
      const target = origin?.isConnected && origin !== document.body ? origin : document.querySelector<HTMLElement>('[data-studio-content-focus]')
      target?.focus({ preventScroll: true })
    }
  }, [invoker])

  function close(viewHistory = false) {
    if (destination.current) return
    destination.current = viewHistory ? 'history' : 'close'
    onExitStart?.(viewHistory)
    dismiss()
  }
  const date = new Date(publishedAt)
  const year = String(date.getFullYear()).replace(/\d/g, digit => inkDigits[Number(digit)])
  const content = (
    <dialog ref={dialog} tabIndex={-1} className="studio-workspace studio-announcement" data-native-back-dismiss
      aria-modal="true" aria-labelledby={titleId} data-phase={phase}
      onCancel={event => { event.preventDefault(); close() }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
      }}>
      <header className="studio-announcement-cover">
        <img ref={cover} src={coverTitle === '最新公告' ? artwork : paper} alt={`启创墨域 Chevoink ${coverTitle}`} />
        {coverTitle !== '最新公告' && <span className="studio-announcement-cover-title" aria-hidden="true">{coverTitle}</span>}
        <time dateTime={publishedAt} aria-label={dateFormat.format(date)}>
          <span>{year}年</span>{inkCalendarNumber(date.getMonth() + 1)}月{inkCalendarNumber(date.getDate())}日
        </time>
      </header>
      <section className="studio-announcement-copy" tabIndex={0} aria-labelledby={titleId}>
        <h2 id={titleId}>{item.title}</h2>
        <p>{item.body}</p>
      </section>
      <footer>
        <button type="button" className="studio-announcement-close" onClick={() => close()}>关闭</button>
        {onHistory && <button type="button" className="studio-announcement-history" onClick={() => close(true)}>查看全部公告</button>}
      </footer>
    </dialog>
  )
  // Keep an explicitly opened notice inside the mobile drawer's focus boundary.
  return invoker ? content : createPortal(content, document.fullscreenElement ?? document.body)
}
