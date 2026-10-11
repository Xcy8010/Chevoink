import { lazy, type ComponentType, type ReactElement } from 'react'
import { Navigate } from 'react-router-dom'

import AuthPage from '@/app/routes/AuthPage'
import NotFoundPage from '@/app/routes/NotFoundPage'
import RequireAuthRoute from '@/app/routes/RequireAuthRoute'
import AdminLayout from '@/features/admin/AdminLayout'
import {
  AuthorSkeleton,
  ConversationSkeleton,
  DiscoverSkeleton,
  PostDetailSkeleton,
  PostListSkeleton,
  ProfileSkeleton,
  ReaderSkeleton,
  SettingsSkeleton,
  StudioSkeleton,
} from '@/components/ui/Skeleton'
import Home from '@/pages/Home'

const CHUNK_RELOAD_KEY = 'chevoink:chunk-reload-at'

/**
 * 懒加载页面 chunk：发版后旧 chunk 被清理导致 404 时，
 * 3 分钟内只自动刷新一次拿新版本，避免刷新死循环。
 */
function lazyPage(load: () => Promise<{ default: ComponentType }>) {
  return lazy(() =>
    load().catch((error) => {
      const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
      if (Date.now() - lastReload > 180_000) {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
        window.location.reload()
      }
      throw error
    }),
  )
}

// 首页/登录/404 保持同步导入保障首屏，其余页面按路由拆包懒加载
const SettingsPage = lazyPage(() => import('@/app/routes/SettingsPage'))
const AccountUsagePage = lazyPage(() => import('@/features/account/AccountUsagePage'))
const AccountProfilePage = lazyPage(() => import('@/features/account/AccountProfilePage'))
const AccountPostsPage = lazyPage(() => import('@/features/account/AccountPostsPage'))
const AccountBillingPage = lazyPage(() => import('@/features/account/AccountBillingPage'))
const AccountPlanPage = lazyPage(() => import('@/features/account/AccountPlanPage'))
const AccountDocsPage = lazyPage(() => import('@/features/account/AccountDocsPage'))
const AuthorPage = lazyPage(() => import('@/pages/AuthorPage'))
const CommunityPage = lazyPage(() => import('@/pages/CommunityPage'))
const DiscoverPage = lazyPage(() => import('@/pages/DiscoverPage'))
const FollowListPage = lazyPage(() => import('@/pages/FollowListPage'))
const LikesListPage = lazyPage(() => import('@/pages/LikesListPage'))
const MessagesPage = lazyPage(() => import('@/pages/MessagesPage'))
const NovelDetailPage = lazyPage(() => import('@/pages/NovelDetailPage'))
const PostDetailPage = lazyPage(() => import('@/pages/PostDetailPage'))
const ProfilePage = lazyPage(() => import('@/pages/ProfilePage'))
const RankingsPage = lazyPage(() => import('@/pages/RankingsPage'))
const ReaderPage = lazyPage(() => import('@/pages/ReaderPage'))
const SearchPage = lazyPage(() => import('@/pages/SearchPage'))
const StudioPage = lazyPage(() => import('@/pages/StudioPage'))
const TopicPage = lazyPage(() => import('@/pages/TopicPage'))

// 后台管理（方案 18）：独立分区，不走主站壳
const AdminLoginPage = lazyPage(() => import('@/features/admin/pages/AdminLoginPage'))
const AdminDashboardPage = lazyPage(() => import('@/features/admin/pages/AdminDashboardPage'))
const AdminUsersPage = lazyPage(() => import('@/features/admin/pages/AdminUsersPage'))
const AdminUserDetailPage = lazyPage(() => import('@/features/admin/pages/AdminUserDetailPage'))
const AdminUserFollowersPage = lazyPage(() => import('@/features/admin/pages/AdminUserFollowersPage'))
const AdminUserFavoriteNovelsPage = lazyPage(() => import('@/features/admin/pages/AdminUserFavoriteNovelsPage'))
const AdminCreationRecordsPage = lazyPage(() => import('@/features/admin/pages/AdminCreationRecordsPage'))
const AdminTokenManagementPage = lazyPage(() => import('@/features/admin/pages/AdminTokenManagementPage'))
const AdminCreditsManagementPage = lazyPage(() => import('@/features/admin/pages/AdminCreditsManagementPage'))
const AdminModelsPage = lazyPage(() => import('@/features/admin/pages/AdminModelsPage'))
const AdminNovelsPage = lazyPage(() => import('@/features/admin/pages/AdminNovelsPage'))
const AdminNovelDetailPage = lazyPage(() => import('@/features/admin/pages/AdminNovelDetailPage'))
const AdminNovelPreviewPage = lazyPage(() => import('@/features/admin/pages/AdminNovelPreviewPage'))
const AdminPostsPage = lazyPage(() => import('@/features/admin/pages/AdminPostsPage'))
const AdminPostDetailPage = lazyPage(() => import('@/features/admin/pages/AdminPostDetailPage'))
const AdminCommentsPage = lazyPage(() => import('@/features/admin/pages/AdminCommentsPage'))
const AdminMessagesPage = lazyPage(() => import('@/features/admin/pages/AdminMessagesPage'))
const AdminAgentEvalsPage = lazyPage(() => import('@/features/admin/pages/AdminAgentEvalsPage'))
const AdminCraftLibraryPage = lazyPage(() => import('@/features/admin/pages/AdminCraftLibraryPage'))
const AdminFeedbackPage = lazyPage(() => import('@/features/admin/pages/AdminFeedbackPage'))
const AdminLogsPage = lazyPage(() => import('@/features/admin/pages/AdminLogsPage'))
const AdminSettingsPage = lazyPage(() => import('@/features/admin/pages/AdminSettingsPage'))

export type AppRouteDefinition = {
  path: string
  title: string
  description: string
  element: ReactElement
  useShell?: boolean
  /** 懒加载 chunk 拉取期间的 Suspense 骨架，不配则用通用骨架 */
  fallback?: ReactElement
}

export const appRoutes: AppRouteDefinition[] = [
  {
    path: '/',
    title: '继续阅读、发现新书，或者直接开始创作',
    description: '在同一页切换阅读、发现与创作，让每天的内容节奏更顺手。',
    element: <Home />,
  },
  {
    path: '/discover',
    title: '按题材、节奏和口味找到下一本想读的书',
    description: '从分类、榜单和书单里快速缩小范围，把更多时间留给正文。',
    element: <DiscoverPage />,
    fallback: <DiscoverSkeleton />,
  },
  {
    path: '/rankings',
    title: '完整榜单：看看大家都在读什么',
    description: '热读、人气、新书、更新、长篇、完结六大榜单，再加玄幻、科幻等分类榜，按排名挑下一本想读的书。',
    element: <RankingsPage />,
    fallback: <DiscoverSkeleton />,
  },
  {
    path: '/search',
    title: '搜索作品、作者与讨论',
    description: '输入关键词，在全站范围内找到想读的书、想关注的作者和感兴趣的讨论。',
    element: <SearchPage />,
  },
  {
    path: '/novel/:novelId',
    title: '先了解这部作品，再决定要不要一口气读下去',
    description: '书名、简介、目录和互动信息都收在同一页，帮助你更快做阅读决定。',
    element: <NovelDetailPage />,
  },
  {
    path: '/novel/:novelId/read/:chapterId',
    title: '沉下心，把这一章安静读完',
    description: '正文始终保持在视觉中心，让切换章节、目录和评论都更自然。',
    element: <ReaderPage />,
    fallback: <ReaderSkeleton />,
  },
  {
    path: '/studio',
    title: '从灵感整理到章节成稿，都能在这里顺着写下去',
    description: '在创作中心集中处理作品信息、章节草稿、AI 辅助写作和封面挑选，保持思路不断线。',
    element: (
      <RequireAuthRoute
        title="登录后即可进入创作中心"
        centered
        description="登录后，你就可以继续整理灵感、编辑章节并管理自己的作品。"
      >
        <StudioPage />
      </RequireAuthRoute>
    ),
    fallback: <StudioSkeleton />,
  },
  {
    path: '/studio/novel/:novelId',
    title: '围绕单部作品继续创作、调整和发布',
    description: '聚焦当前作品的章节推进、内容润色和封面选择，让每一步都更连贯。',
    element: (
      <RequireAuthRoute
        title="登录后即可继续这部作品的创作"
        centered
        description="登录后，你可以回到当前作品，继续编辑章节、整理内容并准备发布。"
      >
        <StudioPage />
      </RequireAuthRoute>
    ),
    fallback: <StudioSkeleton />,
  },
  {
    path: '/community',
    title: '看看大家正在聊什么，也把你的想法发出来',
    description: '创作动态、读后讨论和作品话题都集中在这里，让交流更自然发生。',
    element: <CommunityPage />,
    fallback: <PostListSkeleton />,
  },
  {
    path: '/community/topic/:topicKey',
    title: '围绕这个话题，看看大家聊出了什么',
    description: '同一话题下的讨论都收在这里，按热门或最新继续浏览。',
    element: <TopicPage />,
    fallback: <PostListSkeleton />,
  },
  {
    path: '/messages',
    title: '消息中心',
    description: '在这里查看私聊、互动提醒和更新通知，不错过与你有关的内容。',
    element: (
      <RequireAuthRoute centered title="登录后即可查看消息" description="登录后，即可查看私聊、互动提醒和更新通知。">
        <MessagesPage />
      </RequireAuthRoute>
    ),
    fallback: <ConversationSkeleton />,
  },
  {
    path: '/me',
    title: '管理书架、阅读记录和个人资料',
    description: '把常看的作品、最近的动态和个人信息收进同一个账户中心。',
    element: (
      <RequireAuthRoute
        title="登录后即可查看你的个人中心"
        description="登录后，你的书架、草稿和最近互动都会继续保留。"
      >
        <ProfilePage />
      </RequireAuthRoute>
    ),
    fallback: <ProfileSkeleton />,
  },
  {
    path: '/me/follows',
    title: '看看你关注的人和关注你的人',
    description: '关注与粉丝集中在同一页管理，随时回访、回关或取消关注。',
    element: (
      <RequireAuthRoute
        title="登录后即可查看关注与粉丝"
        description="登录后，你关注的人和关注你的人都会展示在这里。"
      >
        <FollowListPage />
      </RequireAuthRoute>
    ),
  },
  {
    path: '/me/likes',
    title: '看看你的内容收到了哪些互动',
    description: '收到的赞、收藏和评论都会汇总在这里。',
    element: (
      <RequireAuthRoute
        title="登录后即可查看互动消息"
        description="登录后，你收到的赞、收藏和评论会展示在这里。"
      >
        <LikesListPage />
      </RequireAuthRoute>
    ),
  },
  {
    path: '/author/:authorId',
    title: '作者主页',
    description: '在作者主页里集中浏览简介、作品和最近动态，决定要不要继续关注。',
    element: <AuthorPage />,
    useShell: false,
    fallback: <AuthorSkeleton />,
  },
  {
    path: '/author/:authorId/follows',
    title: '作者的关注与粉丝',
    description: '查看这位作者关注的人和关注 TA 的人。',
    element: <FollowListPage />,
    useShell: false,
  },
  {
    path: '/post/:postId',
    title: '继续读完这条讨论，看看大家都在回应什么',
    description: '帖子正文、上下文和互动内容会被收在一起，阅读讨论更连贯。',
    element: <PostDetailPage />,
    fallback: <PostDetailSkeleton />,
  },
  {
    path: '/settings',
    title: '调整显示方式、阅读偏好与账户设置',
    description: '把常用偏好整理在一起，让阅读和创作始终保持熟悉的手感。',
    element: <SettingsPage />,
    fallback: <SettingsSkeleton />,
  },
  {
    path: '/account',
    title: '管理 ChevoInk 账户',
    description: '查看个人信息、账户安全与创作入口。',
    element: <Navigate to="/account/profile" replace />,
    useShell: false,
  },
  {
    path: '/account/profile',
    title: '管理 ChevoInk 账户资料',
    description: '查看个人资料、账户安全状态与创作入口。',
    element: (
      <RequireAuthRoute title="登录后管理账户" description="登录后即可查看个人资料与账户状态。">
        <AccountProfilePage />
      </RequireAuthRoute>
    ),
    useShell: false,
  },
  {
    path: '/account/usage',
    title: '查看 ChevoInk Credits 用量与记录',
    description: '查看公测额度、每日重置时间、邀请奖励和 Credits 消耗记录。',
    element: (
      <RequireAuthRoute title="登录后查看额度" description="登录后即可查看公测 Credits 用量、记录和邀请奖励。">
        <AccountUsagePage />
      </RequireAuthRoute>
    ),
    useShell: false,
  },
  {
    path: '/account/posts',
    title: '管理你在社区发布的讨论',
    description: '集中查看你发布的全部讨论与审核状态。',
    element: (
      <RequireAuthRoute title="登录后查看我的发布" description="登录后即可查看你在社区发布的全部讨论。">
        <AccountPostsPage />
      </RequireAuthRoute>
    ),
    useShell: false,
  },
  {
    path: '/account/billing',
    title: '查看 ChevoInk Credits 月度账单',
    description: '按自然月汇总 Credits 消耗与获得，展开可查看逐条明细。',
    element: (
      <RequireAuthRoute title="登录后查看账单" description="登录后即可查看你的 Credits 月度账单。">
        <AccountBillingPage />
      </RequireAuthRoute>
    ),
    useShell: false,
  },
  {
    path: '/account/plan',
    title: 'ChevoInk 套餐与价格',
    description: '查看公测版套餐权益与后续套餐规划。',
    element: (
      <RequireAuthRoute title="登录后查看套餐" description="登录后即可查看当前套餐权益与规划。">
        <AccountPlanPage />
      </RequireAuthRoute>
    ),
    useShell: false,
  },
  {
    path: '/account/docs',
    title: 'ChevoInk 产品文档',
    description: '产品概述、创作中心、阅读社区与账户额度的完整使用文档。',
    element: (
      <RequireAuthRoute title="登录后查看文档" description="登录后即可浏览启创墨域的完整产品文档。">
        <AccountDocsPage />
      </RequireAuthRoute>
    ),
    useShell: false,
  },
  {
    path: '/login',
    title: '登录启创墨域，继续你的阅读和创作',
    description: '回到书架、草稿和互动记录，把上一次停下的地方接起来。',
    element: <AuthPage mode="login" />,
  },
  {
    path: '/register',
    title: '创建你的启创墨域账户，开始写作和阅读',
    description: '注册后即可收藏作品、发布内容，并把灵感整理成自己的小说。',
    element: <AuthPage mode="register" />,
  },
  {
    path: '/create',
    title: '',
    description: '',
    element: <Navigate to="/studio" replace />,
    useShell: false,
  },
  /* ---------------- 后台管理（/admin 分区，不走主站壳） ---------------- */
  {
    path: '/admin/login',
    title: '管理后台登录',
    description: '启创墨域管理后台，仅限管理员访问。',
    element: <AdminLoginPage />,
    useShell: false,
  },
  {
    path: '/admin',
    title: '管理仪表盘',
    description: '平台内容与管理动作的实时概览。',
    element: (
      <AdminLayout>
        <AdminDashboardPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/users',
    title: '用户管理',
    description: '查看注册用户、封禁违规账号、调整角色或重置密码。',
    element: (
      <AdminLayout>
        <AdminUsersPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/users/:userId',
    title: '用户详情',
    description: '查看单个用户的完整资料与内容统计。',
    element: (
      <AdminLayout>
        <AdminUserDetailPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/users/:userId/followers',
    title: '用户粉丝',
    description: '查看该用户的粉丝列表。',
    element: (
      <AdminLayout>
        <AdminUserFollowersPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/users/:userId/favorites',
    title: '用户收藏作品',
    description: '查看该用户收藏的作品。',
    element: (
      <AdminLayout>
        <AdminUserFavoriteNovelsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/users/:userId/creation-records',
    title: '用户创作记录',
    description: '查看该用户各作品与 Agent 的对话记录。',
    element: (
      <AdminLayout>
        <AdminCreationRecordsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/creation-records',
    title: '创作记录',
    description: '检索用户并查看其各作品与 Agent 的对话记录。',
    element: (
      <AdminLayout>
        <AdminCreationRecordsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/tokens',
    title: 'Token 管理',
    description: '查看全站 AI Token、联网搜索与生图工具用量。',
    element: (
      <AdminLayout>
        <AdminTokenManagementPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/credits',
    title: 'Credits 管理',
    description: '管理公测额度、奖励余额、重置与全局调用状态。',
    element: <AdminLayout><AdminCreditsManagementPage /></AdminLayout>,
    useShell: false,
  },
  {
    path: '/admin/models',
    title: '模型管理',
    description: '配置内置模型、密钥、开放状态与 Credits 倍率。',
    element: <AdminLayout><AdminModelsPage /></AdminLayout>,
    useShell: false,
  },
  {
    path: '/admin/novels',
    title: '作品管理',
    description: '检索全站作品，对违规内容执行下架、恢复或删除。',
    element: (
      <AdminLayout>
        <AdminNovelsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/novels/:novelId',
    title: '作品详情管理',
    description: '查看单部作品的章节与数据，执行下架、恢复或删除。',
    element: (
      <AdminLayout>
        <AdminNovelDetailPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/novels/:novelId/preview',
    title: '作品内部预览',
    description: '管理端内部预览，草稿与已下架作品亦可阅读全文。',
    element: (
      <AdminLayout>
        <AdminNovelPreviewPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/posts',
    title: '帖子管理',
    description: '检索社区帖子，对违规内容执行删除。',
    element: (
      <AdminLayout>
        <AdminPostsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/posts/:postId',
    title: '帖子详情管理',
    description: '查看单条帖子正文与全部评论。',
    element: (
      <AdminLayout>
        <AdminPostDetailPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/comments',
    title: '评论管理',
    description: '检索全站评论，对违规内容执行删除。',
    element: (
      <AdminLayout>
        <AdminCommentsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/messages',
    title: '消息管理',
    description: '查看全站用户的私聊会话与聊天记录。',
    element: (
      <AdminLayout>
        <AdminMessagesPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/evals',
    title: 'Agent 3.5 创作盲评',
    description: '以匿名候选和统一量表开展中文网文专家盲评。',
    element: (
      <AdminLayout>
        <AdminAgentEvalsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/craft',
    title: 'Agent 3.5 合法文笔库',
    description: '管理语料权利台账、审批、受控导入与可追溯撤权。',
    element: (
      <AdminLayout>
        <AdminCraftLibraryPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/feedback',
    title: '用户反馈 / 建议',
    description: '查看创作区提交的问题反馈与功能建议，标记采纳或忽略。',
    element: (
      <AdminLayout>
        <AdminFeedbackPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/logs',
    title: '操作日志',
    description: '所有管理操作留痕，只增不删。',
    element: (
      <AdminLayout>
        <AdminLogsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '/admin/settings',
    title: '安全设置',
    description: '修改管理员登录密码。',
    element: (
      <AdminLayout>
        <AdminSettingsPage />
      </AdminLayout>
    ),
    useShell: false,
  },
  {
    path: '*',
    title: '你访问的页面没有找到',
    description: '换个入口继续浏览，或者回到首页开始阅读与创作。',
    element: <NotFoundPage />,
  },
]
