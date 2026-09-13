import { AdminPageHeader } from '../AdminLayout'
import AdminAnalytics from '../components/AdminAnalytics'

export default function AdminDashboardPage() {
  return <div><AdminPageHeader title="仪表盘" description="平台增长、创作与资源消耗概览" /><AdminAnalytics scope="dashboard" /></div>
}
