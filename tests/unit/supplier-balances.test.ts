import { afterEach, describe, expect, it, vi } from 'vitest'
import { supplierEndpoint, queryDeepSeekBalance } from '../../api/lib/supplier-balances.js'
afterEach(() => vi.unstubAllGlobals())
describe('supplier balance safety', () => {
  it('only accepts the exact documented HTTPS origin', () => {
    expect(supplierEndpoint('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/user/balance')
    for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://key@api.deepseek.com', 'https://api.deepseek.com:123', 'https://127.0.0.1', null]) expect(supplierEndpoint(url)).toBeNull()
  })
  it('preserves monetary strings and currencies, without summing accounts', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12.000001', granted_balance: '2', topped_up_balance: '10.000001' }] })))
    vi.stubGlobal('fetch', fetcher)
    expect(await queryDeepSeekBalance('fixture-key')).toEqual([{ currency: 'CNY', total: '12.000001', granted: '2', toppedUp: '10.000001' }])
    expect(fetcher.mock.calls[0][1].redirect).toBe('error')
  })
  it('does not interpret invalid responses as zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ balance_infos: [] }))))
    await expect(queryDeepSeekBalance('fixture-key')).rejects.toThrow()
  })
  it('does not expose upstream auth response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive upstream error', { status: 401 })))
    await expect(queryDeepSeekBalance('fixture-key')).rejects.toThrow('BALANCE_UNAVAILABLE')
  })
})
