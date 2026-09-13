import { useEffect, useState } from 'react'
import { buildAuthHeader } from '@/lib/auth-token'
import type { NovelImportArtifactDescriptor } from '../../../../shared/contracts/novel-import-preview.js'
import { ImportDialogShell } from './import-dialog-shell'
import { safeImportArtifactUrl } from '../lib/import-artifact'
export function ImportArtifactViewer({ novelId, jobId, artifact, onClose }: { novelId: string; jobId: string; artifact: NovelImportArtifactDescriptor; onClose: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let alive = true, objectUrl = ''
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    void (async () => {
      const target = safeImportArtifactUrl(novelId, jobId, artifact)
      if (!target) throw new Error('图片链接不属于当前导入任务，已阻止打开。')
      const response = await fetch(target, { credentials: 'include', headers: buildAuthHeader(), signal: controller.signal })
      if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== 'image/png') throw new Error('来源图片不可读取，请核对登录状态或重新打开报告。')
      if (Number(response.headers.get('Content-Length')) > 4 * 1024 * 1024 || !response.body) throw new Error('图片超过安全大小或无法读取。')
      const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('图片超过安全上限，已停止读取。') }
        chunks.push(new Uint8Array(result.value))
      }
      const blob = new Blob(chunks, { type: 'image/png' })
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
      if (size !== artifact.bytes || hash !== artifact.sha256) throw new Error('图片内容与报告校验不一致，已停止显示。')
      if (alive) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }
    })().catch(failure => { if (alive) setError(failure instanceof Error && failure.name !== 'AbortError' ? failure.message : '图片加载超时，请稍后重试。') })
    return () => { alive = false; controller.abort(); clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [artifact, jobId, novelId])
  return <ImportDialogShell title="来源图片对照" description={artifact.source} stage="source-image" onClose={onClose} footer={<button type="button" data-import-safe-focus className="min-h-11 rounded border px-3" onClick={onClose}>返回报告</button>}>
    {error ? <p role="alert">{error}</p> : url ? <img className="mx-auto h-auto max-w-full" src={url} alt={`原文件来源图片：${artifact.source}`} /> : <p role="status">正在鉴权并校验来源图片…</p>}
    <p className="text-xs">图片仅用于对照原文，不自动识别、不自动设为封面。</p>
  </ImportDialogShell>
}
