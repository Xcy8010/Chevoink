import { useQuery } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
import type { AdminNovelRow } from '../../../shared/contracts/index.js'
import { getAdminMe } from './api'

/* ---------------- 会话守卫 ---------------- */

/**
 * 管理后台会话守卫：拉取 /api/admin/me。
 * 401 时跳转登录页；加载中渲染骨架；其余错误就地提示。
 */
export function useAdminSession() {
  const query = useQuery({
    queryKey: ['admin', 'me'],
    queryFn: getAdminMe,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  const denied = query.error instanceof ApiClientError && (query.error.status === 401 || query.error.status === 403)

  return { admin: query.data ?? null, isLoading: query.isLoading, denied }
}

/* ---------------- 时间格式化 ---------------- */

export function formatDateTime(value: string | null): string {
  if (!value) {
    return '—'
  }

  const date = new Date(value)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('zh-CN')
}

/* ---------------- 操作动作文案 ---------------- */

const ACTION_LABELS: Record<string, string> = {
  'tester.grant': '授予测试员资格', 'tester.revoke': '撤销测试员资格',
  'site_content.create': '新增公开内容草稿', 'site_content.save': '保存公开内容草稿', 'site_content.publish': '发布公开内容',
  'site_content.withdraw': '撤下公开内容', 'site_content.delete': '删除公开展示', 'site_content.restore': '恢复内容版本', 'site_content.replaced': '替换公告',
  'registration.legal_consent': '注册协议确认',

  'admin.login': '登录后台',
  'admin.change_own_password': '修改自己密码',
  'user.ban': '封禁用户',
  'user.unban': '解封用户',
  'user.set_role': '调整角色',
  'user.set_identity': '调整用户身份',
  'app_release.import': '登记应用版本',
  'app_release.assign_test': '推送测试版本',
  'app_release.full_release': '全量发布版本',
  'app_release.withdraw_test': '撤回测试版本',
  'app_release.rollback': '回退稳定版本',
  'user.reset_password': '重置密码',
  'novel.take_down': '下架作品',
  'novel.restore': '恢复作品',
  'novel.delete': '删除作品',
  'chapter.delete': '删除章节',
  'post.delete': '删除帖子',
  'comment.delete': '删除评论',
  'feedback.status': '处理用户反馈',
}

export function describeAdminAction(action: string): string {
  return ACTION_LABELS[action] ?? action
}

/* ---------------- 作品状态 ---------------- */

export const NOVEL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  published: '连载中',
  completed: '已完结',
  archived: '已归档',
}

/** 下架唯一信号是 status==='archived'（管理端下架与作者归档共同写入）；
 * visibility==='private' 仅代表仅自己可见，草稿默认即私有，不能判为已下架 */
export function isNovelTakenDown(novel: AdminNovelRow): boolean {
  return novel.status === 'archived'
}
