import { useAdminQueryState } from '../admin-query-state'
import { useAdminNumberQuery } from './admin-page-query'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { cn } from '@/lib/utils'
import type { AdminConversationRow } from '../../../../shared/contracts/index.js'
import { getAdminConversationMessages, listAdminConversations } from '../api'
import { AdminCard, AdminPageHeader, AdminPager, AdminPanelState, StatusPill } from '../AdminLayout'
import { formatDateTime } from '../admin-shared'

const CONVERSATION_TYPE_LABELS: Record<string, string> = {
  direct: '私聊',
  system: '系统通知',
}

/** 卡片类消息在管理端以标签 + 文本兜底展示 */
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  novelCard: '作品卡片',
  postCard: '帖子卡片',
  authorCard: '作者卡片',
  commentCard: '评论卡片',
  system: '系统消息',
}

function conversationTitle(conversation: AdminConversationRow): string {
  if (conversation.title) {
    return conversation.title
  }
  const names = conversation.members.map((member) => member.nickname).join('、')
  return names || '未命名会话'
}

function Avatar({ nickname, avatarUrl }: { nickname: string; avatarUrl: string | null }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={nickname} className="h-8 w-8 shrink-0 rounded-full object-cover" />
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-xs font-semibold">
      {nickname.slice(0, 1)}
    </span>
  )
}

export default function AdminMessagesPage() {
  const [search, setSearch] = useAdminQueryState('search', '')
  const [keyword, setKeyword] = useState(search)
  const [page, setPage] = useAdminNumberQuery('page', 1)
  const [pageSize, setPageSize] = useAdminNumberQuery('pageSize', 10)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ['admin', 'conversations', search, page, pageSize],
    queryFn: () => listAdminConversations({ search: search || undefined, page, pageSize }),
  })

  const messagesQuery = useQuery({
    queryKey: ['admin', 'conversations', selectedId, 'messages'],
    queryFn: () => getAdminConversationMessages(selectedId as string),
    enabled: Boolean(selectedId),
  })

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(1)
  }

  const data = listQuery.data
  const selected = data?.items.find((item) => item.id === selectedId) ?? null
  const messages = messagesQuery.data?.messages ?? []

  return (
    <div>
      <AdminPageHeader title="消息稽核" description="仅用于授权的违规调查；按成员检索后查看会话，继续遵守管理员权限和访问留痕。" />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        {/* 会话列表 */}
        <AdminCard className={cn(selectedId && 'hidden lg:block')}>
          <form
            className="mb-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSearch(keyword.trim())
              setPage(1)
            }}
          >
            <TextInput value={keyword} placeholder="成员昵称" onChange={(event) => setKeyword(event.target.value)} />
            <Button type="submit" variant="primary">
              搜索
            </Button>
          </form>

          <AdminPanelState
            state={listQuery.isLoading ? 'loading' : listQuery.isError ? 'error' : data && data.items.length === 0 ? 'empty' : 'ready'}
          >
            {data ? (
              <>
                <ul className="divide-y divide-[var(--border-default)] md:max-h-[56vh] md:overflow-y-auto md:pr-1">
                  {data.items.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(conversation.id)}
                        className={cn(
                          'block w-full rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]',
                          selectedId === conversation.id && 'bg-[var(--surface-muted)]',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{conversationTitle(conversation)}</p>
                          <StatusPill>{CONVERSATION_TYPE_LABELS[conversation.type] ?? conversation.type}</StatusPill>
                        </div>
                        <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">
                          {conversation.lastMessagePreview ?? '暂无消息'}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                          {conversation.messageCount} 条消息 · {formatDateTime(conversation.lastMessageAt)}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
                <AdminPager
                  pagination={data.pagination}
                  page={page}
                  pageSize={pageSize}
                  onPageChange={setPage}
                  onPageSizeChange={handlePageSizeChange}
                />
              </>
            ) : null}
          </AdminPanelState>
        </AdminCard>

        {/* 聊天记录 */}
        <AdminCard className={cn(!selectedId && 'hidden lg:block')}>
          {selectedId === null ? (
            <div className="py-16 text-center text-sm text-[var(--text-secondary)]">选择左侧会话查看完整聊天记录</div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--border-default)] pb-3">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] lg:hidden"
                  >
                    <ArrowLeft size={13} />
                    返回
                  </button>
                  <p className="truncate text-sm font-semibold">
                    {selected ? conversationTitle(selected) : '聊天记录'}
                  </p>
                  {selected ? (
                    <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                      {selected.members.length} 人 · {selected.messageCount} 条消息
                    </span>
                  ) : null}
                </div>
              </div>

              <AdminPanelState
                state={messagesQuery.isLoading ? 'loading' : messagesQuery.isError ? 'error' : messages.length === 0 ? 'empty' : 'ready'}
              >
                <ul className="divide-y divide-[var(--border-default)] md:max-h-[62vh] md:overflow-y-auto md:pr-1">
                  {messages.map((message) => (
                    <li key={message.id} className="flex items-start gap-2.5 py-2.5">
                      <Avatar nickname={message.sender.nickname} avatarUrl={message.sender.avatarUrl} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--text-secondary)]">
                          <span className="text-sm text-[var(--text-primary)]">{message.sender.nickname}</span>
                          <span>{formatDateTime(message.createdAt)}</span>
                          {MESSAGE_TYPE_LABELS[message.type] ? (
                            <StatusPill>{MESSAGE_TYPE_LABELS[message.type]}</StatusPill>
                          ) : null}
                        </div>
                        {message.type === 'image' ? (
                          <img
                            src={message.content}
                            alt="聊天图片"
                            className="mt-1.5 max-h-44 rounded-lg border border-[var(--border-default)] object-cover"
                          />
                        ) : (
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </AdminPanelState>
            </>
          )}
        </AdminCard>
      </div>
    </div>
  )
}
