import { useSearchParams } from 'react-router-dom'
import { effectiveSiteSettings } from './defaults'
import { usePublicSiteContent, useRegistrationPolicies } from './public-api'
import SiteSupportLink from './SiteSupportLink'

export default function LegalPage() {
  const [params] = useSearchParams()
  const kind = params.get('kind') === 'privacy' ? 'privacy' : 'terms'
  const query = useRegistrationPolicies()
  const siteContent = usePublicSiteContent()
  const policy = query.data?.legal[kind]
  const supportUrl = effectiveSiteSettings(siteContent.data?.settings).contact.url

  return (
    <article className="mx-auto max-w-3xl space-y-4 py-8">
      <h1 className="text-2xl font-semibold">{policy?.payload.title ?? (kind === 'terms' ? '用户协议' : '隐私政策')}</h1>
      {query.isLoading ? <p>加载中…</p> : query.isError ? <p>暂时无法读取政策，请稍后重试。</p> : policy ? (
        <>
          <p className="text-sm text-[var(--text-secondary)]">版本 {policy.contentVersion} · 生效时间 {new Date(policy.payload.effectiveAt).toLocaleString()}</p>
          <p className="whitespace-pre-wrap break-words leading-7">{policy.payload.body}</p>
        </>
      ) : <p>正式政策尚未发布。</p>}
      <SiteSupportLink href={supportUrl} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 text-sm hover:bg-[var(--surface-muted)]" />
    </article>
  )
}
