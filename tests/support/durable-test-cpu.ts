import { Session, type Profiler } from 'node:inspector'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type DurableCpuFrame = { file: string; name: string; selfMs: number; inclusiveMs: number }
export type DurableCpuSummary = { samples: number; totalMs: number; idleMs: number; self: DurableCpuFrame[]; own: DurableCpuFrame[] }
const round = (value: number) => Math.round(value * 10) / 10

function frameName(frame: Profiler.ProfileNode['callFrame'], root: string) {
  let file = '[runtime]'
  try {
    const url = frame.url.startsWith('file:') ? fileURLToPath(frame.url) : frame.url
    const relative = path.relative(root, url).split(path.sep).join('/')
    if (/^(api|scripts|tests|node_modules)\/[A-Za-z0-9_./@-]+$/.test(relative) && relative.length <= 160) file = relative
    else if (/^node:[A-Za-z0-9_/-]+$/.test(frame.url)) file = frame.url
    else if (!frame.url) file = '[v8]'
  } catch { /* Unknown/evaluated URLs never appear in a public profile. */ }
  const name = /^[A-Za-z0-9_$ .<>()[\]:-]{0,80}$/.test(frame.functionName) ? frame.functionName || '(anonymous)' : '(anonymous)'
  return { file, name }
}

/** Only code locations and sampled time; never source text, SQL, arguments,
 * function values, heap data, absolute host paths or provider/user content. */
export function summarizeDurableCpu(profile: Profiler.Profile, root: string): DurableCpuSummary {
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const frames = new Map<string, DurableCpuFrame>(), samples = profile.samples ?? [], deltas = profile.timeDeltas ?? []
  let totalMs = 0, idleMs = 0
  for (const [index, id] of samples.entries()) {
    const duration = (deltas[index] ?? 0) / 1000
    if (!Number.isFinite(duration) || duration < 0) continue
    totalMs += duration
    if (nodes.get(id)?.callFrame.functionName === '(idle)') idleMs += duration
    let current: number | undefined = id
    const visited = new Set<number>()
    while (current !== undefined && visited.size < 128 && !visited.has(current)) {
      visited.add(current)
      const node = nodes.get(current)
      if (!node) break
      const label = frameName(node.callFrame, root), key = `${label.file}:${label.name}`
      const frame = frames.get(key) ?? { ...label, selfMs: 0, inclusiveMs: 0 }
      frame.inclusiveMs += duration
      if (current === id) frame.selfMs += duration
      frames.set(key, frame); current = parent.get(current)
    }
  }
  const present = (frame: DurableCpuFrame) => ({ ...frame, selfMs: round(frame.selfMs), inclusiveMs: round(frame.inclusiveMs) })
  return { samples: samples.length, totalMs: round(totalMs), idleMs: round(idleMs),
    self: [...frames.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 8).map(present),
    own: [...frames.values()].filter(frame => frame.file.startsWith('api/')).sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 8).map(present) }
}

/** Test-only local inspector session. No listener/port or remote connection is
 * opened. Sampling does not change test deadlines, assertions or DB behavior. */
export async function startDurableTestCpuProfile() {
  const session = new Session()
  session.connect()
  try {
    await new Promise<void>((resolve, reject) => session.post('Profiler.enable', error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => session.post('Profiler.setSamplingInterval', { interval: 1000 }, error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()))
  } catch (error) { session.disconnect(); throw error }
  let stopping: Promise<DurableCpuSummary> | undefined
  return () => stopping ??= new Promise<Profiler.Profile>((resolve, reject) => session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile)))
    .then(profile => summarizeDurableCpu(profile, process.cwd())).finally(() => session.disconnect())
}
