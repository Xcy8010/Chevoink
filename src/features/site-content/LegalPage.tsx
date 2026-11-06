import { useSearchParams } from 'react-router-dom'
import { useRegistrationPolicies } from './public-api'
export default function LegalPage() {
  const [params]=useSearchParams()
  const kind=params.get('kind')==='privacy' ? 'privacy' : 'terms'
  const query=useRegistrationPolicies()
  const policy=query.data?.legal[kind]
  return <article className="mx-auto max-w-3xl space-y-4 py-8"><h1 className="text-2xl font-semibold">{policy?.payload.title ?? (kind==='terms' ? '服务条款' : '隐私政策')}</h1>{query.isLoading ? <p>加载中…</p> : query.isError ? <p>暂时无法读取政策，请稍后重试。</p> : policy ? <><p className="text-sm text-[var(--text-secondary)]">版本 {policy.contentVersion} · 生效时间 {new Date(policy.payload.effectiveAt).toLocaleString()}</p><p className="whitespace-pre-wrap leading-7">{policy.payload.body}</p></> : <p>正式政策尚未发布。</p>}</article>
}