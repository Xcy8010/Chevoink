import type { ToolContext } from './types.js'

/** Bounded to one execution. A lost observation requires another read. */
export function recordPlanContentHash(ctx: ToolContext, id: string, hash: string, planHash?: string) {
  if (planHash && ctx.planSemanticHashes) {
    ctx.planSemanticHashes.delete(id)
    ctx.planSemanticHashes.set(id, planHash)
    while (ctx.planSemanticHashes.size > 128) ctx.planSemanticHashes.delete(ctx.planSemanticHashes.keys().next().value!)
  }
  const cache = ctx.planContentHashes
  if (!cache) return
  cache.delete(id)
  cache.set(id, hash)
  while (cache.size > 128) cache.delete(cache.keys().next().value!)
}
