import type { ToolContext } from './types.js'

/** Bounded to one execution. A lost observation requires another read. */
export function recordPlanContentHash(ctx: ToolContext, id: string, hash: string) {
  const cache = ctx.planContentHashes
  if (!cache) return
  cache.delete(id)
  cache.set(id, hash)
  while (cache.size > 128) cache.delete(cache.keys().next().value!)
}
