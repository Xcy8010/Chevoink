import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Network, RefreshCw } from 'lucide-react'

import StudioPaneSkeleton from './StudioPaneSkeleton'
import { loadStudioSurface } from './load-studio-surface'
import type { MemoryGraphLayoutResult } from '../lib/memory-graph.worker'
import { cn } from '@/lib/utils'
import { ApiClientError } from '@/app/api-client'
import { getMemoryGraphJob, getNovelMemoryGraph, syncNovelMemoryGraph } from '../api'

// Geometry lives as long as the queried graph; returning to a warm graph skips another worker solve.
const layoutsByGraph = new WeakMap<object, Map<number, MemoryGraphLayoutResult>>()

const loadCanvas = () => import('./MemoryGraphCanvas')
const MemoryGraphCanvas = loadStudioSurface(loadCanvas, '关系网画布', 'graph')

class GraphCanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <div role="alert" className="grid h-full place-content-center gap-2 text-center text-sm">
      关系网画布暂时无法显示。
      <button type="button" className="underline" onClick={() => this.setState({ failed: false })}>重新打开画布</button>
    </div>
  }
}

/** 关系网 AI 重建是异步任务，前端以固定间隔轮询后端 job 进度，避免同步等待 AI 重建到超时。 */
const GRAPH_JOB_POLL_MS = 1200

type JobState = { id: string; status: 'pending' | 'running' | 'completed' | 'failed'; done: number; total: number; error?: string | null }

export default function MemoryGraph({ novelId, active = false, className }: { novelId: string; active?: boolean; className?: string }) {
  const queryClient = useQueryClient()
  const syncAttemptedRef = useRef(new Set<string>())
  const [job, setJob] = useState<JobState | null>(null)
  // Fetch the renderer alongside the graph instead of waiting for its API response.
  useEffect(() => { void loadCanvas().catch(() => {}) }, [])

  const graphQuery = useQuery({
    queryKey: ['studio', novelId, 'memory-graph'],
    queryFn: async () => {
      try { return await getNovelMemoryGraph(novelId) }
      catch (error) {
        // An explicit denial supersedes any previously cached private graph.
        if (error instanceof ApiClientError && [401, 403, 404].includes(error.status)) return null
        throw error
      }
    },
    refetchInterval: active ? 5_000 : false,
    staleTime: 10_000,
  })
  const graph = graphQuery.data

  const startMutation = useMutation({
    mutationFn: (force: boolean) => syncNovelMemoryGraph(novelId, force),
    onSuccess: (data) => setJob({ id: data.jobId, status: 'running', done: 0, total: 0 }),
  })

  // 后端分块并发抽取整书关系网，前端轮询 job；完成后刷新图。
  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return
    const timer = window.setInterval(async () => {
      try {
        const next = await getMemoryGraphJob(novelId, job.id)
        setJob({ id: next.jobId, status: next.status, done: next.doneChunks, total: next.totalChunks, error: next.error })
        if (next.status === 'completed') {
          await queryClient.invalidateQueries({ queryKey: ['studio', novelId, 'memory-graph'], exact: true })
        }
      } catch (error) {
        setJob((prev) => prev
          ? { ...prev, status: 'failed', error: error instanceof Error ? error.message : '关系网刷新失败，请稍后再试。' }
          : prev)
      }
    }, GRAPH_JOB_POLL_MS)
    return () => window.clearInterval(timer)
  }, [job, novelId, queryClient])

  const jobBusy = job?.status === 'running' || job?.status === 'pending' || startMutation.isPending

  // 仅空图自动初始化；已有关系网不因进入页面重复调用模型。
  useEffect(() => {
    if (graphQuery.isError || !graph || graph.nodes.length > 0 || jobBusy || syncAttemptedRef.current.has(novelId)) return
    syncAttemptedRef.current.add(novelId)
    startMutation.mutate(false)
  }, [graph, graphQuery.isError, novelId, jobBusy, startMutation])

  if (graphQuery.isLoading) {
    return <StudioPaneSkeleton label="正在载入小说关系网" shape="graph" />
  }

  if (graph === null || (graphQuery.isError && !graph)) {
    return <div className={cn('flex h-full flex-col items-center justify-center gap-3 px-6 text-center', className)}><Network className="h-8 w-8 text-[var(--text-tertiary)]" /><p className="text-sm text-[var(--text-secondary)]">关系网暂时无法载入。</p><button type="button" onClick={() => void graphQuery.refetch()} className="text-xs text-[var(--text-primary)] underline underline-offset-4">重新加载</button></div>
  }

  if ((!graph || graph.nodes.length === 0) && jobBusy) {
    return <div className={cn('flex h-full items-center justify-center gap-2 text-sm text-[var(--text-secondary)]', className)}><LoaderCircle className="h-4 w-4 animate-spin" />AI 正在从正文建立小说关系网…</div>
  }

  if (!graph || graph.nodes.length === 0) {
    return <div className={cn('flex h-full flex-col items-center justify-center px-8 text-center', className)}><Network className="h-9 w-9 text-[var(--text-tertiary)]" /><h3 className="mt-3 text-sm font-medium text-[var(--text-primary)]">关系网还没有内容</h3><p className="mt-2 max-w-sm text-xs leading-6 text-[var(--text-secondary)]">作品有正文后会用低推理 AI 自动建立一次，覆盖人物、地点、组织、物件、事件和概念。</p></div>
  }

  // Entity metadata can change on any poll. Tie geometry to the query lifetime;
  // the worker separately keys each result by the actual nodes and routed edges.
  const query = queryClient.getQueryCache().find({ queryKey: ['studio', novelId, 'memory-graph'], exact: true })
  let layoutCache = query && layoutsByGraph.get(query)
  if (query && !layoutCache) {
    layoutCache = new Map()
    layoutsByGraph.set(query, layoutCache)
  }

  return <section className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface-default)]', className)} aria-label="小说关系网">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
      <Network className="h-4 w-4 text-[var(--text-secondary)]" />
      <span className="text-xs font-medium text-[var(--text-primary)]">关系网</span>
      <span className="truncate text-[10px] tabular-nums text-[var(--text-tertiary)]">{graph.nodes.length} 个实体 · {graph.edges.length} 条关系</span>
      <button type="button" disabled={jobBusy} onClick={() => startMutation.mutate(true)} className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:opacity-45" aria-label="刷新关系网" title="用低推理 AI 刷新关系网（10 分钟内限一次）">{jobBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
    </div>
    {jobBusy ? <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-[10px] text-[var(--text-secondary)]"><LoaderCircle className="h-3 w-3 animate-spin" />AI 正在从正文刷新关系网{job && job.total > 0 ? `（${job.done}/${job.total}）` : ''}，请稍候…</div> : null}
    {job?.status === 'failed' && job.error ? <p className="border-b border-[var(--border-subtle)] px-3 py-2 text-[10px] text-rose-500">{job.error}</p> : null}
    <div className="min-h-0 flex-1">
      <GraphCanvasBoundary key={novelId}><MemoryGraphCanvas graph={graph} layoutCache={layoutCache} /></GraphCanvasBoundary>
    </div>
  </section>
}
