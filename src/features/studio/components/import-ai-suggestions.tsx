import { useEffect, useRef, useState } from 'react'
import { importSuggestionsApi, validateImportBoundaries, type ImportSuggestionBoundary, type ImportSuggestionQuote, type ImportSuggestionResult, type ImportSuggestionSelection } from '../import-suggestions-api'
import { importErrorMessage } from '../lib/import-labels'
import { ImportDialogShell } from './import-dialog-shell'

const button = 'min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 text-sm disabled:opacity-40'
export function ImportAiSuggestions(props: {
  novelId: string; jobId: string; selection: ImportSuggestionSelection; content: string; disabled: boolean
  onApply: (boundaries: ImportSuggestionBoundary[]) => void; client?: typeof importSuggestionsApi
}) {
  // Changing chapter/revision must remount this scope, never apply a result to another chapter.
  const key = `${props.novelId}:${props.jobId}:${props.selection.manifestHash}:${props.selection.manifestRevision}:${props.selection.volumeIndex}:${props.selection.chapterIndex}`
  return <SuggestionSession key={key} {...props} />
}

function SuggestionSession({ novelId, jobId, selection, content, disabled, onApply, client = importSuggestionsApi }: Parameters<typeof ImportAiSuggestions>[0]) {
  const [quote, setQuote] = useState<ImportSuggestionQuote | null>(null)
  const [result, setResult] = useState<ImportSuggestionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const lock = useRef(false)
  const allowed = useRef(!disabled)
  allowed.current = !disabled && !!content.trim() && content.length <= 7000
  useEffect(() => () => { epoch.current++ }, [])
  useEffect(() => { setArmed(false); const timer = setTimeout(() => setArmed(true), 450); return () => clearTimeout(timer) }, [quote])
  const run = async (action: (alive: () => boolean) => Promise<void>) => {
    if (lock.current) return
    const owner = epoch.current
    const alive = () => owner === epoch.current
    lock.current = true; setBusy(true); setError('')
    try { await action(alive) } catch (failure) { if (alive()) setError(failure instanceof Error ? failure.message : '建议请求失败，请查询记录。') }
    finally { if (alive()) { lock.current = false; setBusy(false) } }
  }
  const refresh = () => void run(async alive => {
    const records = await client.list(novelId, jobId)
    if (!alive()) return
    const current = records.find(item => item.manifestRevision === selection.manifestRevision && item.manifestHash === selection.manifestHash && item.volumeIndex === selection.volumeIndex && item.chapterIndex === selection.chapterIndex)
    if (current) { setResult(current); setUnknown(current.status === 'pending') }
    else if (unknown) setError('尚未查询到结果，请稍后再次查询；不会自动重发付费请求。')
  })
  return <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-3" aria-label="局部 AI 结构建议">
    <p className="text-sm">可选：仅分析当前已保存章节，模型只给分章建议，不补写正文。每次最多 7,000 字符，超过请先手动拆分；这是范围限制，不截断原文。每任务最多 4 次，仍以服务器预算检查为准。</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={disabled || busy || unknown || !content.trim() || content.length > 7000} onClick={() => { if (!allowed.current) return; void run(async alive => { const next = await client.quote(novelId, jobId, selection); if (alive() && allowed.current) setQuote(next) }) }}>查看模型与费用</button><button type="button" className={button} disabled={busy} onClick={refresh}>查询建议记录</button></div>
    {disabled && <p className="text-xs">请先保存预览调整并完成当前导入条件检查。</p>}
    {busy && <p role="status">正在处理结构建议请求…</p>}
    {error && <p role="alert">{error}</p>}
    {unknown && <p role="status">结果待核对。收起不会撤销已发生的模型请求；请查询持久记录，不重复发送。</p>}
    {result && <div className="space-y-2 text-sm"><p>建议状态：{result.status === 'succeeded' ? '已生成，尚未应用' : result.status === 'pending' ? '等待结果' : '未完成'}</p>{result.errorCode && <><p role="alert">{importErrorMessage(result.errorCode)}</p><details><summary>技术详情</summary><p>{result.errorCode}</p></details></>}{result.status === 'succeeded' && result.result && <><p className="whitespace-pre-wrap break-words">{result.result.note}</p><ol>{result.result.boundaries.map((item, index) => <li key={index}>字符 {item.offset}：{item.title}</li>)}</ol><button type="button" className={button} disabled={disabled || busy || !validateImportBoundaries(content, result.result.boundaries)} onClick={event => { if (event.detail > 1 || !result.result || !validateImportBoundaries(content, result.result.boundaries)) return; onApply(result.result.boundaries); setResult(null) }}>应用这些边界（不改写正文）</button></>}</div>}
    {quote && <ImportDialogShell title="确认 AI 结构分析费用？" description="只发送当前章节，不自动应用建议或导入作品。" stage="ai-budget" onClose={() => setQuote(null)} footer={<><button type="button" className={button} data-import-safe-focus onClick={() => setQuote(null)}>取消</button><button type="button" className={button} disabled={!armed || busy || disabled || unknown || !quote.modelName} onClick={event => {
      if (event.detail > 1 || !armed || !allowed.current) return
      void run(async alive => {
        setUnknown(true); setQuote(null)
        const next = await client.request(novelId, jobId, selection, quote.fingerprint)
        if (alive()) { setResult(next); setUnknown(next.status === 'pending') }
      })
    }}>同意费用并请求建议</button></>}><div className="space-y-3 text-sm"><p>实际模型：{quote.modelName ?? '模型名称不可用，请核对配置'} · {quote.kind === 'custom' ? '本任务固定自定义模型' : '内置基础模型'} · 思考档位：{quote.reasoningEffort}</p><p>本次上限：输入 {quote.maxInputTokens} Token，输出 {quote.maxOutputTokens} Token。</p><p>{quote.notice}</p><p>这是用量上限，不是现金报价；供应商费用可能另计。模型配置变化须重新确认。</p></div></ImportDialogShell>}
  </section>
}
