import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import MemoryGraphCanvas from '../../src/features/studio/components/MemoryGraphCanvas'
import { memoryGraphFixture, memoryGraphHubFixture } from './memory-graph'

// This instrumentation belongs only to this public synthetic preview, never the application renderer.
const diagnostics = { rafCallbacks: 0, canvasDraws: 0, maxRafCallbackMs: 0, lastCanvasDrawAt: 0, lastFrameNames: 0, lastFrameRelations: 0 }
const originalRaf = window.requestAnimationFrame.bind(window)
window.requestAnimationFrame = (callback) => originalRaf((time) => {
  const start = performance.now()
  callback(time)
  diagnostics.rafCallbacks += 1
  diagnostics.maxRafCallbackMs = Math.max(diagnostics.maxRafCallbackMs, performance.now() - start)
})
const originalClear = CanvasRenderingContext2D.prototype.clearRect
CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
  diagnostics.canvasDraws += 1
  diagnostics.lastFrameNames = 0; diagnostics.lastFrameRelations = 0
  diagnostics.lastCanvasDrawAt = performance.now()
  return originalClear.call(this, x, y, width, height)
}

const originalText = CanvasRenderingContext2D.prototype.fillText
const relationTypes = new Set(memoryGraphFixture.edges.map((edge) => edge.type))
CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
  if (relationTypes.has(text)) diagnostics.lastFrameRelations += 1
  else diagnostics.lastFrameNames += 1
  if (maxWidth === undefined) return originalText.call(this, text, x, y)
  return originalText.call(this, text, x, y, maxWidth)
}
export default function Preview() {
  const [narrow, setNarrow] = useState(false)
  const [hub, setHub] = useState(false)
  const [dark, setDark] = useState(true)
  const [snapshot, setSnapshot] = useState('')
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--app-bg)', color: 'var(--text-primary)' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12 }}>
      <span>公开合成数据 · {hub ? '枢纽' : '稀疏'} · 103 个实体 · 145 条语义关系</span>
      <button type="button" onClick={() => setHub(!hub)} style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px' }}>{hub ? '切换稀疏拓扑' : '切换枢纽拓扑'}</button>
      <button type="button" onClick={() => setNarrow(!narrow)} style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px' }}>{narrow ? '恢复全宽' : '模拟 390px 容器'}</button>
      <button type="button" onClick={() => { document.documentElement.classList.toggle('dark', !dark); setDark(!dark) }} style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px' }}>{dark ? '浅色' : '深色'}</button>
      <button type="button" onClick={() => setSnapshot(JSON.stringify({ ...diagnostics, maxRafCallbackMs: Math.round(diagnostics.maxRafCallbackMs * 100) / 100, idleSinceCanvasDrawMs: diagnostics.lastCanvasDrawAt ? Math.round(performance.now() - diagnostics.lastCanvasDrawAt) : null }))} style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px' }}>采样诊断</button>
      <button type="button" onClick={() => { Object.assign(diagnostics, { rafCallbacks: 0, canvasDraws: 0, maxRafCallbackMs: 0, lastCanvasDrawAt: 0 }); setSnapshot('诊断已重置') }} style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 10px' }}>重置诊断</button>
      <output style={{ fontFamily: 'monospace', fontSize: 10, overflowWrap: 'anywhere' }}>{snapshot}</output>
    </div>
    <div style={{ width: narrow ? 'min(390px, 100%)' : '100%', flex: 1, minHeight: 0, margin: '0 auto', position: 'relative', background: 'var(--surface-default)' }}><MemoryGraphCanvas graph={hub ? memoryGraphHubFixture : memoryGraphFixture} /></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
