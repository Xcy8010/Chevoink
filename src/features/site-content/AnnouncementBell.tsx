import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, Bell, CheckCheck, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AnnouncementNotification, PersonalNotification } from '../../../shared/contracts/site-content'
import { useAnnouncementInbox } from './announcement-inbox-api'
import './announcements.css'

type Placement = 'site' | 'studio' | 'studio-mobile'
type InboxItem = PersonalNotification & { type: 'announcement' | 'personal' }
const announcementItem = (item: AnnouncementNotification): InboxItem => ({ ...item, type: 'announcement', id: item.versionId })
const itemKey = (item: InboxItem) => item.type + ':' + item.id
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Shanghai',
})

function PublishedTime({ value }: { value: string }) {
  return <time dateTime={value} title="北京时间（UTC+8）">{dateFormat.format(new Date(value))}</time>
}

export default function AnnouncementBell({ placement }: { placement: Placement }) {
  const [anchor, setAnchor] = useState<{ top: number; right: number; bottom: number } | null>(null)
  const { query, read, viewerId } = useAnnouncementInbox(true, anchor !== null)
  const dialogId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const items: InboxItem[] = [
    ...(query.data?.items ?? []).map(announcementItem),
    ...(query.data?.personalItems ?? []).map((item): InboxItem => ({ ...item, type: 'personal' })),
  ]
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || itemKey(b).localeCompare(itemKey(a)))
  const unread = items.filter(item => item.unread).length
  const label = unread ? '未读通知' : '通知中心'

  function open() {
    const rect = trigger.current!.getBoundingClientRect()
    setAnchor({
      top: rect.bottom + 8,
      right: Math.max(12, window.innerWidth - rect.right),
      bottom: window.innerHeight - rect.top + 8,
    })
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
      onMarkAll={() => { if (viewerId) read.mutate({ viewerId, action: 'allNotifications' }) }}
      onMarkRead={item => {
        if (viewerId) read.mutate(item.type === 'personal'
          ? { viewerId, action: 'personal', notificationId: item.id }
          : { viewerId, action: 'one', versionId: item.id })
      }}
    />}
  </>
}

export function AnnouncementHistoryDialog({ returnFocus, onClose }: {
  returnFocus: HTMLElement | null
  onClose: () => void
}) {
  const id = useId()
  const { query, read, viewerId } = useAnnouncementInbox(true, true)
  const items = (query.data?.items ?? []).map(announcementItem)
  return <InboxDialog
    key={viewerId}
    id={id}
    returnFocus={returnFocus}
    placement="history"
    items={items}
    unread={items.filter(item => item.unread).length}
    viewerId={viewerId}
    loading={query.isPending}
    loadError={query.isError && !query.data}
    readPending={read.isPending}
    readError={read.isError}
    onRetry={() => { void query.refetch() }}
    onClose={onClose}
    onMarkAll={() => { if (viewerId) read.mutate({ viewerId, action: 'all' }) }}
    onMarkRead={item => { if (viewerId) read.mutate({ viewerId, action: 'one', versionId: item.id }) }}
  />
}

type InboxDialogProps = {
  id: string
  returnFocus: HTMLElement | null
  placement: Placement | 'history'
  anchor?: { top: number; right: number; bottom: number }
  items: InboxItem[]
  unread: number
  viewerId: string | null
  loading: boolean
  loadError: boolean
  readPending: boolean
  readError: boolean
  onRetry: () => void
  onClose: () => void
  onMarkAll: () => void
  onMarkRead: (item: InboxItem) => void
}

function InboxDialog(props: InboxDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lastRow = useRef<HTMLButtonElement | null>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const titleId = useId()
  const detail = props.items.find(item => itemKey(item) === selected)
  const detailKey = detail ? itemKey(detail) : null
  const isHistory = props.placement === 'history'
  const listTitle = isHistory ? '全部公告' : '通知中心'

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
    if (detailKey) detailHeading.current?.focus({ preventScroll: true })
    else lastRow.current?.focus({ preventScroll: true })
  }, [detailKey])

  return <dialog
    ref={dialog}
    id={props.id}
    aria-labelledby={titleId}
    data-native-back-dismiss
    data-announcement-inbox
    className={cn(
      'site-announcement-inbox',
      props.placement === 'studio-mobile' && 'site-announcement-inbox--mobile',
      isHistory && 'site-announcement-inbox--history',
    )}
    style={props.anchor && {
      '--announcement-top': props.anchor.top + 'px',
      '--announcement-right': props.anchor.right + 'px',
      '--announcement-bottom': props.anchor.bottom + 'px',
    } as CSSProperties}
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
          ? <button type="button" className="site-announcement-dialog-close" aria-label={isHistory ? '返回公告列表' : '返回通知列表'} onClick={() => setSelected(null)}><ArrowLeft aria-hidden="true" size={18} /></button>
          : <Bell aria-hidden="true" size={18} className="shrink-0 text-[var(--text-secondary)]" />}
        <h2 id={titleId} className="mr-auto text-sm font-semibold">{detail ? (detail.type === 'personal' ? '个人通知详情' : '公告详情') : listTitle}</h2>
        {!detail && props.unread > 0 && <span className="site-announcement-inbox-count">{props.unread} 条未读</span>}
        {!detail && props.viewerId && <button type="button" className="site-announcement-inbox-action" disabled={!props.unread || props.readPending} onClick={props.onMarkAll}>
          <CheckCheck aria-hidden="true" size={16} />全部已读
        </button>}
        <button type="button" className="site-announcement-dialog-close" aria-label={'关闭' + listTitle} onClick={props.onClose}><X aria-hidden="true" size={18} /></button>
      </header>
      {props.readError && <p role="alert" className="site-announcement-inbox-error">未能更新已读状态，请重试。</p>}
      <div className="site-announcement-inbox-scroll" hidden={Boolean(detail)}>
        {props.loading && <p role="status" className="site-announcement-inbox-empty">正在加载…</p>}
        {props.loadError && <div className="site-announcement-inbox-empty">
          <p role="alert">暂时无法加载</p>
          <button type="button" className="site-announcement-inbox-action mt-2" onClick={props.onRetry}>重试</button>
        </div>}
        {!props.loading && !props.loadError && !props.items.length && <div className="site-announcement-inbox-empty">
          <Bell aria-hidden="true" size={23} className="mx-auto mb-2 opacity-60" />
          <p>{isHistory ? '暂无公告' : '暂无通知'}</p>
        </div>}
        <ul className="site-announcement-inbox-list">
          {props.items.map((item, index) => <li key={itemKey(item)}>
            <button type="button" className="site-announcement-inbox-row" data-unread={item.unread || undefined} onClick={event => {
              lastRow.current = event.currentTarget
              setSelected(itemKey(item))
              if (item.unread) props.onMarkRead(item)
            }}>
              <span className="site-announcement-inbox-row-dot" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-all font-medium">{item.title}</span>
                  {index === 0 && <span className="site-announcement-inbox-new">NEW</span>}
                  {item.unread && <span className="sr-only">未读</span>}
                </span>
                <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                  {!isHistory && <>{item.type === 'personal' ? '个人通知' : '站点公告'} · </>}
                  <PublishedTime value={item.publishedAt} />
                </span>
              </span>
              <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </li>)}
        </ul>
      </div>
      {detail && <article className="site-announcement-inbox-scroll site-announcement-inbox-detail" key={detailKey}>
        <h3 tabIndex={-1} ref={detailHeading} className="break-words text-base font-semibold">{detail.title}</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]"><PublishedTime value={detail.publishedAt} /> · UTC+8</p>
        <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{detail.body}</p>
        {props.readError && detail.unread && <button type="button" className="site-announcement-inbox-action mt-4" onClick={() => props.onMarkRead(detail)}>重试标记已读</button>}
      </article>}
    </div>
  </dialog>
}
