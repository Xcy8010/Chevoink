import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, Bell, CheckCheck, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AnnouncementNotification } from '../../../shared/contracts/site-content'
import { useAnnouncementInbox } from './announcement-inbox-api'
import './announcements.css'

type Placement = 'site' | 'studio' | 'studio-mobile'
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Shanghai',
})

function PublishedTime({ value }: { value: string }) {
  return <time dateTime={value} title="北京时间（UTC+8）">{dateFormat.format(new Date(value))}</time>
}

export default function AnnouncementBell({ placement }: { placement: Placement }) {
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const { query, read, viewerId } = useAnnouncementInbox(true, anchor !== null)
  const dialogId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const items = query.data?.items ?? []
  const unread = items.filter(item => item.unread).length
  const label = unread ? '未读通知' : '公告通知'

  function open() {
    const rect = trigger.current!.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) })
    read.reset()
    if (viewerId) void query.refetch()
  }

  return <>
    <button
      ref={trigger}
      type="button"
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={anchor !== null}
      aria-controls={anchor ? dialogId : undefined}
      className={cn(
        'site-announcement-bell',
        placement === 'studio' && 'site-announcement-bell--compact',
        placement === 'studio-mobile' && 'site-announcement-bell--plain',
      )}
      onClick={open}
    >
      <span className="relative inline-flex">
        <Bell aria-hidden="true" size={18} />
        {unread > 0 && <span aria-hidden="true" className="site-announcement-bell-dot" />}
      </span>
    </button>
    {anchor && <InboxDialog
      key={viewerId}
      id={dialogId}
      returnFocus={trigger.current}
      placement={placement}
      anchor={anchor}
      items={items}
      unread={unread}
      viewerId={viewerId}
      loading={query.isFetching && !query.data}
      loadError={query.isError && !query.data}
      readPending={read.isPending}
      readError={read.isError}
      onRetry={() => { void query.refetch() }}
      onClose={() => setAnchor(null)}
      onMarkAll={() => { if (viewerId) read.mutate({ viewerId, action: 'all' }) }}
      onMarkRead={versionId => { if (viewerId) read.mutate({ viewerId, action: 'one', versionId }) }}
    />}
  </>
}

type InboxDialogProps = {
  id: string
  returnFocus: HTMLButtonElement | null
  placement: Placement
  anchor: { top: number; right: number }
  items: AnnouncementNotification[]
  unread: number
  viewerId: string | null
  loading: boolean
  loadError: boolean
  readPending: boolean
  readError: boolean
  onRetry: () => void
  onClose: () => void
  onMarkAll: () => void
  onMarkRead: (versionId: string) => void
}

function InboxDialog(props: InboxDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lastRow = useRef<HTMLButtonElement | null>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const titleId = useId()
  const detail = props.items.find(item => item.versionId === selected)
  const detailVersionId = detail?.versionId

  const { returnFocus } = props
  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    return () => {
      node.close()
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [returnFocus])
  useEffect(() => {
    if (detailVersionId) detailHeading.current?.focus({ preventScroll: true })
    else lastRow.current?.focus({ preventScroll: true })
  }, [detailVersionId])

  return <dialog
    ref={dialog}
    id={props.id}
    aria-labelledby={titleId}
    data-native-back-dismiss
    data-announcement-inbox
    className={cn('site-announcement-inbox', props.placement === 'studio-mobile' && 'site-announcement-inbox--mobile')}
    style={{ '--announcement-top': props.anchor.top + 'px', '--announcement-right': props.anchor.right + 'px' } as CSSProperties}
    onCancel={event => { event.preventDefault(); props.onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose()
    }}
  >
    <div className="site-announcement-inbox-frame">
      <header className="site-announcement-inbox-header">
        {detail
          ? <button type="button" className="site-announcement-dialog-close" aria-label="返回公告列表" onClick={() => setSelected(null)}><ArrowLeft aria-hidden="true" size={18} /></button>
          : <Bell aria-hidden="true" size={18} className="shrink-0 text-[var(--text-secondary)]" />}
        <h2 id={titleId} className="mr-auto text-sm font-semibold">{detail ? '公告详情' : '公告通知'}</h2>
        {!detail && props.unread > 0 && <span className="site-announcement-inbox-count">{props.unread} 条未读</span>}
        {!detail && props.viewerId && <button type="button" className="site-announcement-inbox-action" disabled={!props.unread || props.readPending} onClick={props.onMarkAll}>
          <CheckCheck aria-hidden="true" size={16} />全部已读
        </button>}
        <button type="button" className="site-announcement-dialog-close" aria-label="关闭公告通知" onClick={props.onClose}><X aria-hidden="true" size={18} /></button>
      </header>
      {props.readError && <p role="alert" className="site-announcement-inbox-error">未能更新已读状态，请重试。</p>}
      <div className="site-announcement-inbox-scroll" hidden={Boolean(detail)}>
        {props.loading && <p role="status" className="site-announcement-inbox-empty">正在加载公告…</p>}
        {props.loadError && <div className="site-announcement-inbox-empty">
          <p role="alert">暂时无法加载公告</p>
          <button type="button" className="site-announcement-inbox-action mt-2" onClick={props.onRetry}>重试</button>
        </div>}
        {!props.loading && !props.loadError && !props.items.length && <div className="site-announcement-inbox-empty">
          <Bell aria-hidden="true" size={23} className="mx-auto mb-2 opacity-60" />
          <p>暂无公告</p>
        </div>}
        <ul className="site-announcement-inbox-list">
          {props.items.map((item, index) => <li key={item.versionId}>
            <button type="button" className="site-announcement-inbox-row" data-unread={item.unread || undefined} onClick={event => {
              lastRow.current = event.currentTarget
              setSelected(item.versionId)
              if (item.unread) props.onMarkRead(item.versionId)
            }}>
              <span className="site-announcement-inbox-row-dot" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-all font-medium">{item.title}</span>
                  {index === 0 && <span className="site-announcement-inbox-new">NEW</span>}
                  {item.unread && <span className="sr-only">未读</span>}
                </span>
                <span className="mt-1 block text-xs text-[var(--text-secondary)]"><PublishedTime value={item.publishedAt} /></span>
              </span>
              <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </li>)}
        </ul>
      </div>
      {detail && <article className="site-announcement-inbox-scroll site-announcement-inbox-detail" key={detail.versionId}>
        <h3 tabIndex={-1} ref={detailHeading} className="break-words text-base font-semibold">{detail.title}</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]"><PublishedTime value={detail.publishedAt} /> · UTC+8</p>
        <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{detail.body}</p>
        {props.readError && detail.unread && <button type="button" className="site-announcement-inbox-action mt-4" onClick={() => props.onMarkRead(detail.versionId)}>重试标记已读</button>}
      </article>}
    </div>
  </dialog>
}
