import { useCallback, useEffect, useState, type FormEvent } from 'react'
import SupplementForm from './SupplementForm'
import { ApiClientError, requestJson } from '@/app/api-client'
import { caseStatuses, type CaseRow, type AppealSubject } from '../../../shared/contracts/governance-cases'
import { control, action, post, errorText } from './common'
import { Captcha, type Challenge } from './Captcha'

type Inbox = { subjects: AppealSubject[]; cases: (CaseRow & { conclusion: string | null })[] }
export default function AppealsPage() {
  const [proof, setProof] = useState(''),
    [inbox, setInbox] = useState<Inbox>(),
    [mode, setMode] = useState<'password' | 'code'>('password')
  const [identity, setIdentity] = useState(''),
    [secret, setSecret] = useState(''),
    [challenge, setChallenge] = useState<Challenge>(),
    [attempt, setAttempt] = useState(0)
  const [id, setId] = useState(''),
    [statement, setStatement] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('')
  const endVerification = useCallback(() => {
    setProof('')
    setInbox(undefined)
    setIdentity('')
    setSecret('')
    setId('')
    setStatement('')
    setMessage('')
    setError('')
    setKey(crypto.randomUUID())
  }, [])
  useEffect(() => {
    if (!proof) return
    const timer = window.setTimeout(endVerification, 20 * 60_000)
    return () => window.clearTimeout(timer)
  }, [proof, endVerification])
  async function read(token: string) {
    const next = await requestJson<Inbox>('/api/governance/appeal', {
      credentials: 'omit',
      headers: { 'X-Appeal-Proof': token },
    })
    setInbox(next)
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await fn()
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'APPEAL_VERIFICATION_REQUIRED') endVerification()
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  function resetChallenge() {
    setChallenge(undefined)
    setAttempt((n) => n + 1)
  }
  function verify(e: FormEvent) {
    e.preventDefault()
    void run(async () => {
      try {
        const result =
          mode === 'password'
            ? await post<{ proof: string }>('/api/governance/appeal/verify-password', {
                identity,
                password: secret,
              })
            : await post<{ proof: string }>('/api/governance/appeal/verify-code', {
                email: identity,
                code: secret,
              })
        await read(result.proof)
        setProof(result.proof)
        setSecret('')
      } finally {
        resetChallenge()
      }
    })
  }
  const subject = inbox?.subjects.find((s) => s.id === id)
  return (
    <main className="mx-auto max-w-xl space-y-5 px-5 py-10">
      <h1 className="text-2xl font-semibold">提交申诉</h1>
      <p>账号受到限制时仍可在此核验身份、查看决定、反馈记录错误或补充新证据。</p>
      {!proof ? (
        <form className="space-y-4" onSubmit={verify}>
          <label>
            核验方式
            <select
              className={control}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode)
                setSecret('')
                resetChallenge()
              }}
            >
              <option value="password">账号密码</option>
              <option value="code">绑定邮箱验证码</option>
            </select>
          </label>
          <label>
            {mode === 'password' ? '绑定邮箱或手机号' : '绑定邮箱'}
            <input
              className={control}
              autoComplete="username"
              type={mode === 'code' ? 'email' : 'text'}
              required
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
            />
          </label>
          {mode === 'code' && <Captcha key={attempt} onChange={setChallenge} />}
          {mode === 'code' && (
            <button
              type="button"
              className={action}
              disabled={busy || !challenge?.answer}
              onClick={() =>
                void run(async () => {
                  try {
                    await post('/api/governance/appeal/code', { email: identity, challenge })
                    setMessage('如果账号符合条件，验证码会发送至绑定邮箱。')
                  } finally {
                    resetChallenge()
                  }
                })
              }
            >
              发送验证码
            </button>
          )}
          <label>
            {mode === 'password' ? '账号密码' : '邮箱验证码'}
            <input
              required
              className={control}
              autoComplete={mode === 'password' ? 'current-password' : 'one-time-code'}
              type={mode === 'password' ? 'password' : 'text'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button disabled={busy} className={action}>
            {busy ? '处理中…' : '核验身份并查看案件'}
          </button>
        </form>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button className={action} disabled={busy} onClick={() => void run(() => read(proof))}>
              刷新进度
            </button>
            <button className={action} disabled={busy} onClick={endVerification}>
              结束核验
            </button>
          </div>
          {inbox?.subjects.length ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  const r = await post<{ id: string }>(
                    '/api/governance/appeal',
                    { requestKey: key, targetId: id, statement },
                    { 'X-Appeal-Proof': proof },
                  )
                  setMessage('已收到申诉，编号 ' + r.id)
                  setStatement('')
                  setKey(crypto.randomUUID())
                  await read(proof)
                })
              }}
            >
              <label>
                选择需复核的决定
                <select
                  className={control}
                  required
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value)
                    setKey(crypto.randomUUID())
                  }}
                >
                  <option value="">请选择</option>
                  {inbox.subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.measure} · {s.id}
                    </option>
                  ))}
                </select>
              </label>
              {subject && (
                <div className="rounded-lg border border-[var(--border-subtle)] p-3">
                  <p>{subject.reason}</p>
                  <p>适用条款 {subject.clause}</p>
                  {subject.kind === 'restriction' && (
                    <p>期限 {subject.expiresAt ? new Date(subject.expiresAt).toLocaleString() : '永久'}</p>
                  )}
                </div>
              )}
              <label>
                申诉说明或补充证据
                <textarea
                  className={control}
                  required
                  maxLength={4000}
                  rows={5}
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                />
              </label>
              <button className={action} disabled={busy}>
                提交复核
              </button>
            </form>
          ) : (
            <p>当前没有可申诉的决定。</p>
          )}
          <h2 className="font-semibold">我的申诉</h2>
          {inbox?.cases.length ? (
            inbox.cases.map((c) => (
              <div key={c.id} className="border-b border-[var(--border-subtle)] py-2">
                <p>
                  {caseStatuses[c.status]} · {c.id}
                </p>
                {c.publicProgress && <p>{c.publicProgress}</p>}
                {c.conclusion && <p>{c.conclusion}</p>}
                {!c.materialsAt && c.status === 'investigating' && (
                  <SupplementForm id={c.id} proof={proof} onSaved={() => read(proof)} />
                )}
              </div>
            ))
          ) : (
            <p>暂无申诉记录。</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <p className="text-sm text-[var(--text-secondary)]">
        收到申诉后 3 个工作日内确认受理，收到必要材料后 15 个工作日内反馈结果或进展。
      </p>
    </main>
  )
}
