export const loadFollowListPage = () => import('@/pages/FollowListPage')
export const loadLikesListPage = () => import('@/pages/LikesListPage')

export function preloadMessageDetailPages() {
  void Promise.allSettled([loadFollowListPage(), loadLikesListPage()])
}
