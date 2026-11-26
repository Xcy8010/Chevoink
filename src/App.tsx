import AppProviders from '@/app/AppProviders'
import AppRouter, { AppRoutes } from '@/app/AppRouter'

export default function App() {
  return (
    <AppRouter>
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </AppRouter>
  )
}
