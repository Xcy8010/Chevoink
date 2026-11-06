import { afterEach, expect, it } from 'vitest'
import { formatShanghaiDateInput, parseShanghaiDateInput } from '../../src/features/admin/site-content-time'
const previous=process.env.TZ
afterEach(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous})
it('uses the same Asia/Shanghai instant regardless of browser/runtime timezone',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Pacific/Honolulu','Asia/Shanghai']){
  process.env.TZ=zone
  expect(parseShanghaiDateInput('2026-11-06T19:30'),zone).toBe('2026-11-06T11:30:00.000Z')
  expect(formatShanghaiDateInput('2026-11-06T11:30:00.000Z'),zone).toBe('2026-11-06T19:30')
 }
})
it('preserves empty date editing without substituting the browser clock',()=>{expect(parseShanghaiDateInput('')).toBe('');expect(formatShanghaiDateInput('')).toBe('');expect(parseShanghaiDateInput('not-a-date')).toBe('')})