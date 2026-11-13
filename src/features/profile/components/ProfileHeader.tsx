import { Camera, Settings } from 'lucide-react'

import Button from '@/components/ui/Button'
import Avatar from '@/features/community/components/Avatar'
import type { User } from '../../../../shared/contracts'

type ProfileStatKey = 'reading' | 'following' | 'followers' | 'likes'

type ProfileHeaderProps = {
  user: User
  coverUrl: string | null
  readingCount: number
  likesCount: number | null
  onEditProfile: () => void
  onSetCover: () => void
  onGoSettings: () => void
  onStatClick: (key: ProfileStatKey) => void
}

/**
 * 个人中心头部：X 风格平铺结构——固定比例封面（object-cover 裁剪不拉伸）、
 * 头像压住封面下缘、昵称/简介/数据全部为纯文本行，不做容器套容器。
 */
export default function ProfileHeader({
  user,
  coverUrl,
  readingCount,
  likesCount,
  onEditProfile,
  onSetCover,
  onGoSettings,
  onStatClick,
}: ProfileHeaderProps) {
  const stats: Array<{ key: ProfileStatKey; label: string; value: number | null }> = [
    { key: 'reading', label: '阅读', value: readingCount },
    { key: 'following', label: '关注', value: user.followingCount },
    { key: 'followers', label: '粉丝', value: user.followerCount },
    { key: 'likes', label: '获赞', value: likesCount },
  ]

  return (
    <section>
      {/* 封面：与上传裁剪比例保持一致的 3:1，三端都完整显示不二次裁切 */}
      <div className="relative aspect-[3/1] w-full overflow-hidden rounded-[var(--radius-xl)]">
        {coverUrl ? (
          <img src={coverUrl} alt="个人封面" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-[linear-gradient(135deg,#28435f_0%,#16233a_58%,#1f2f47_100%)]" />
        )}
        <button
          type="button"
          onClick={onSetCover}
          className="press-feedback absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-black/40 px-3 py-1.5 text-xs font-medium text-white backdrop-blur transition-colors hover:bg-black/55"
        >
          <Camera className="h-3.5 w-3.5" />
          {coverUrl ? '更换封面' : '设置封面'}
        </button>
      </div>

      {/* 头像悬出封面下缘，操作按钮右对齐——同一行，无卡片包裹 */}
      <div className="flex items-start justify-between px-1 sm:px-2">
        <Avatar
          name={user.nickname}
          src={user.avatarUrl}
          size="lg"
          className="relative z-10 -mt-9 h-[76px] w-[76px] border-4 border-[var(--app-bg)] bg-[var(--surface-muted)] sm:-mt-12 sm:h-24 sm:w-24"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onGoSettings}
            aria-label="前往设置"
            className="press-feedback inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <Settings className="h-4 w-4" />
          </button>
          <Button variant="secondary" size="sm" onClick={onEditProfile}>
            编辑资料
          </Button>
        </div>
      </div>

      <div className="mt-2.5 space-y-2 px-1 sm:px-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 className="truncate text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">
            {user.nickname}
          </h2>
          {user.isAuthor ? (
            <span className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)]">
              创作者
            </span>
          ) : null}
        </div>

        <p className="line-clamp-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
          {user.bio || '先把简介补完整，让其他人更容易认识你，也更容易记住你正在读和正在写什么。'}
        </p>

        {/* 数据行：纯文本平铺可点击，点击进入对应列表，小屏自动收紧字号不换行 */}
        <p className="flex items-center gap-4 text-[13px] text-[var(--text-tertiary)] sm:gap-5 sm:text-sm">
          {stats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              onClick={() => onStatClick(stat.key)}
              className="press-feedback whitespace-nowrap transition-colors hover:text-[var(--text-secondary)] hover:underline hover:underline-offset-4"
            >
              <span className="font-semibold tabular-nums text-[var(--text-primary)]">{stat.value ?? '—'}</span>{' '}
              {stat.label}
            </button>
          ))}
        </p>
      </div>
    </section>
  )
}
