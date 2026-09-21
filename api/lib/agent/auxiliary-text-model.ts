import type { ToolContext } from './tools/types.js'

/** Auxiliary text must not turn a free/BYOK task into a paid platform call.
 * Preserve the entire server-resolved route, credentials and capabilities.
 * Paid tasks retain their existing independent-review model policy. */
export function auxiliaryTextModel(runtime: ToolContext['modelRuntime']): ToolContext['modelRuntime'] {
  return runtime && (runtime.tier === 'custom' || runtime.multiplierBps === 0) ? runtime : undefined
}
