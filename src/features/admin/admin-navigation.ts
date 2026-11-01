export const adminNavigation = [
  { label: '内容与社区', items: [
    { to: '/admin/novels', label: '作品管理', keywords: '内容 下架 恢复' },
    { to: '/admin/posts', label: '社区帖子', keywords: '社区 帖子' },
    { to: '/admin/comments', label: '社区评论', keywords: '评论 作品 帖子' },
    { to: '/admin/feedback', label: '用户反馈', keywords: '建议 待处理' },
    { to: '/admin/messages', label: '消息稽核', keywords: '私人消息 稽核' },
  ] },
  { label: '用户与权益', items: [
    { to: '/admin/users', label: '用户管理', keywords: '角色 封禁' },
    { to: '/admin/credits', label: 'Credits 权益', keywords: '账户 额度 全局政策 暂停 重置' },
  ] },
  { label: '创作运营', items: [
    { to: '/admin/creation-records', label: '创作运行', keywords: '任务 运行 工具 导入 统计' },
    { to: '/admin/evals', label: '创作盲评', keywords: '评测 套件 量表' },
    { to: '/admin/craft', label: '合法文笔库', keywords: '授权 来源 审核' },
  ] },
  { label: '模型与资源', items: [
    { to: '/admin/models', label: '模型中心', keywords: '配置 供应商 渠道 Search Fetch 协议' },
    { to: '/admin/tokens', label: '用量与运行', keywords: 'Token 调用 健康 成本 余额 缓存' },
  ] },
  { label: '系统管理', items: [
    { to: '/admin/settings', label: '管理员安全', keywords: '密码 手机 安全' },
    { to: '/admin/logs', label: '操作审计', keywords: '日志 管理员 变更' },
  ] },
] as const
export const adminPages = [{ to: '/admin', label: '总览', keywords: '待办 异常 趋势' }, ...adminNavigation.flatMap<{ to: string; label: string; keywords: string }>(group => [...group.items])]
export function searchAdminPages(query: string) {
  const keyword = query.trim().toLocaleLowerCase()
  return keyword ? adminPages.filter(page => `${page.label} ${page.keywords}`.toLocaleLowerCase().includes(keyword)) : adminPages
}
export function adminCurrentPage(pathname: string) {
  return [...adminPages].sort((a, b) => b.to.length - a.to.length).find(page => page.to === '/admin' ? pathname === '/admin' : pathname === page.to || pathname.startsWith(`${page.to}/`)) ?? adminPages[0]
}
