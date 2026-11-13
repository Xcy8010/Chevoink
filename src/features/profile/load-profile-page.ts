export const loadProfilePage = () => import('@/pages/ProfilePage')

export function preloadProfilePage() {
  void loadProfilePage().catch(() => undefined)
}
