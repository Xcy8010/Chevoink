import { ReportDialogHost } from '@/features/governance/Reports'
import AppProviders from '@/app/AppProviders'
import AppRouter, { AppRoutes } from '@/app/AppRouter'

export default function App() {
  return (
    <AppRouter>
      <AppProviders>
        <AppRoutes />
        <ReportDialogHost />
      </AppProviders>
    </AppRouter>
  )
}
