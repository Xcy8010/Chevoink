export const adminNavigation = [
  {label:'内容治理',items:[
    {to:'/admin/governance/reports',label:'举报与投诉',keywords:'内容治理 案件 调查'},
    {to:'/admin/governance/safety',label:'Agent 安全记录',keywords:'警告 复核 误判'},
    {to:'/admin/governance/reconciliation',label:'异常使用与对账',keywords:'云枢 异常用量 账本'},
    {to:'/admin/governance/restrictions',label:'处罚管理',keywords:'账号 限制 期限'},
    {to:'/admin/governance/appeals',label:'申诉管理',keywords:'申诉 复核 调整'},
  ]},
  { label: '内容与社区', items: [
    { to: '/admin/content', label: '公告与帮助政策', keywords: '公告 帮助 文档 用户协议 服务条款 隐私政策 发布 草稿' },
    { to: '/admin/novels', label: '作品管理', keywords: '内容 下架 恢复' },
    { to: '/admin/posts', label: '社区帖子', keywords: '社区 帖子' },
    { to: '/admin/comments', label: '社区评论', keywords: '评论 作品 帖子' },
    { to: '/admin/feedback', label: '用户反馈', keywords: '建议 待处理' },
    { to: '/admin/messages', label: '消息稽核', keywords: '私人消息 稽核' },
  ] },
  { label: '用户与权益', items: [
    { to: '/admin/users', label: '用户管理', keywords: '角色 身份 测试员 资格 权益 封禁' },
    { to: '/admin/email', label: '定向邮件', keywords: '邮件 模板 选人 抽样 投递 回执' },
    { to: '/admin/credits', label: 'Credits 权益', keywords: '账户 额度 全局政策 暂停 重置 奖励 赠送 扣减 覆盖' },
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
    { to: '/admin/app-releases', label: '应用版本', keywords: '稳定 测试 灰度 全量 版本 回退 发布 更新 产物' },
    { to: '/admin/site-settings', label: '站点设置', keywords: '名称 Logo 页脚 关于 联系 导航' },
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
