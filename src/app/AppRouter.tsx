import { Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { appRoutes } from '@/app/route-config'
import AccountAccessGate from '@/app/routes/AccountAccessGate'
import AppShell from '@/components/layout/AppShell'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'

/** 未指定专属骨架的懒加载路由通用占位 */
const defaultRouteFallback = (
  <div className="space-y-4 py-2" aria-busy="true" aria-label="页面加载中">
    <Skeleton className="h-7 w-48" />
    <SkeletonText lines={4} />
    <Skeleton className="h-40 w-full rounded-[var(--radius-xl)]" />
  </div>
)

export default function AppRouter() {
  return (
    <BrowserRouter>
      <AccountAccessGate><Routes>
        {appRoutes.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              route.useShell === false ? (
                <Suspense fallback={route.fallback ?? defaultRouteFallback}>{route.element}</Suspense>
              ) : (
                // Suspense 放在壳内：顶栏/底栏立即可交互，只内容区显示骨架
                <AppShell title={route.title} description={route.description}>
                  <Suspense fallback={route.fallback ?? defaultRouteFallback}>{route.element}</Suspense>
                </AppShell>
              )
            }
          />
        ))}
      </Routes></AccountAccessGate>
    </BrowserRouter>
  )
}
