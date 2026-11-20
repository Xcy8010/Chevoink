import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { deviceName, enrichDeviceName } from '../../api/lib/device-name.js'

function android(comment: string, hint?: string) {
  return { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; ' + comment + ') Chrome/132.0',
    'sec-ch-ua-model': hint } } as Request
}

describe('client-reported device model labels', () => {
  it.each(['Pixel 8 Pro', 'Pixel Fold', 'Redmi Note 13 Pro', 'SM-S9210', '24031PN0DC', 'CPH2499', 'VOG-L29'])(
    'reads a quoted hint from a reduced UA (%s)', model => {
      expect(deviceName(android('K', '"' + model + '"'))).toBe('Android · ' + model + ' · Chrome')
    })
  it.each(['K', 'AMD64', 'AArch64', 'x86_64', 'Pixel Alice 123', '358123456789012', 'SN1234567', 'USER4567', 'SM-ALICES-PHONE', 'unknown', 'email@example.com',
    'Pixel 8; account=alice', '550e8400-e29b-41d4-a716-446655440000', 'SM-S9210 Build/UP1A.231005', 'Pixel\n8'])(
    'keeps generic, private and unstructured values out of the label (%s)', value => {
      expect(deviceName(android('K', '"' + value + '"'))).toBe('Android · Chrome')
    })
  it('uses the Android device field when no hint is available, without retaining the build or locale', () => {
    expect(deviceName(android('zh-CN; Pixel 8 Pro Build/AP1A.240305.019; wv'))).toBe('Android · Pixel 8 Pro · 应用')
    expect(deviceName(android('SM-S9210'))).toBe('Android · SM-S9210 · Chrome')
  })
  it('fills a missing model once while preserving the recorded client and any established model', () => {
    const req = android('K', '"Pixel 8 Pro"')
    expect(enrichDeviceName(req, 'Android · 应用')).toBe('Android · Pixel 8 Pro · 应用')
    expect(enrichDeviceName(req, 'Android · SM-S9210 · 应用')).toBeUndefined()
    expect(enrichDeviceName(req, 'Windows · Edge')).toBeUndefined()
    expect(enrichDeviceName(req, '旧版登录（合并显示）')).toBeUndefined()
  })
})
