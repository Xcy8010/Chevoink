import { expect } from 'vitest'

/** Legacy direct handlers and durable adapters expose the same confirmed
 * rejection either as a domain error or as a persisted failed tool result. */
export async function expectToolDenied(promise: Promise<unknown>, expected: { code: unknown }) {
  const observed = await promise.then(value => ({ value }), error => ({ error }))
  if ('error' in observed) { expect(observed.error).toMatchObject(expected); return }
  const response = observed.value as { kind?: string; result?: unknown }
  const result = (response?.kind === 'tool' ? response.result : observed.value) as { outcome?: string; failureCode?: string }
  expect(result).toMatchObject({ outcome: 'failed' })
  expect({ code: result.failureCode }).toMatchObject(expected)
}
