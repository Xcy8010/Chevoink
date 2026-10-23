import { afterEach, describe, expect, it } from 'vitest'
import { buildZipBuffer, freezeZipTimestamp } from '../../api/lib/zip-writer.js'
import { buildPublishAdviceRequest, parsePublishAdviceResponse } from '../../api/lib/ai-service.js'
import { JSZip } from './novel-import-parser.fixtures.js'
import { assertExportCapacity } from '../../api/lib/agent/runtime-export-contract.js'

const originalTimezone = process.env.TZ
afterEach(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone })

describe('export original bytes and bounded ZIP replay', () => {
  it('reassembles the same frozen stamp across timezones without changing the manuscript bytes', async () => {
    process.env.TZ = 'Asia/Shanghai'
    const stamp = freezeZipTimestamp(new Date('2026-10-23T00:00:00Z'))
    const body = Buffer.from(`  合成原文\r\n${'大稿件'.repeat(400000)}\n\t末尾  `)
    const entries = [{ path: '合成作品/正文/第一卷/第0001章 雪原.txt', data: body }]
    const first = buildZipBuffer(entries, stamp)
    process.env.TZ = 'America/New_York'
    const replay = buildZipBuffer(entries, stamp)
    expect(replay.equals(first)).toBe(true)
    const archive = await JSZip.loadAsync(replay)
    expect((await archive.file(entries[0].path)!.async('nodebuffer')).equals(body)).toBe(true)
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024)
  })
  it('rejects non-ZIP64 entry/name/stamp overflow before writing a malformed archive', () => {
    const empty = { path: '合法.txt', data: new Uint8Array() }
    expect(() => buildZipBuffer(Array.from({ length: 65536 }, () => empty))).toThrow('ZIP_FORMAT_LIMIT')
    expect(() => buildZipBuffer([{ ...empty, path: '名'.repeat(22000) }])).toThrow('ZIP_FORMAT_LIMIT')
    expect(() => buildZipBuffer([empty], { time: -1, date: 0 })).toThrow('ZIP_FORMAT_LIMIT')
  })
  it('preserves the original publish-advice prompt, first-1500-character sample and vocabulary sanitizer', () => {
    const sample = '样'.repeat(1500) + '不可扩大到样章之外'
    const prompt = buildPublishAdviceRequest({ title: '雪原', summary: '合成简介', genre: '探险', tags: ['冒险'], sampleText: sample })
    expect(prompt.userPrompt).toContain('正文样章：' + '样'.repeat(1500))
    expect(prompt.userPrompt).not.toContain('不可扩大到样章之外')
    expect(prompt.systemPrompt).toContain('严禁使用清单之外的标签')
    const advice = parsePublishAdviceResponse(JSON.stringify({ channel: '男频', mainCategory: '编造分类', themeTags: ['编造标签'], roleTags: [], plotTags: [],
      contentPlotTags: [], contentRoleTags: [], contentEmotionTags: [], contentWorldviewTags: [], protagonists: [], summary: '合成简介' }))
    expect(advice.mainCategory).not.toBe('编造分类')
    expect(advice.themeTags).not.toContain('编造标签')
    expect(advice.summary).toBe('合成简介')
  })
  it.each(['../private.txt', '/absolute.txt', 'safe/../outside.txt', 'safe\\outside.txt', 'safe/\u0000name.txt'])('rejects unsafe frozen ZIP path %s', path => {
    expect(() => assertExportCapacity({ entries: [{ path, data: Buffer.from('original').toString('base64') }], fileName: 'export.zip', summary: '合成', zipStamp: { time: 0, date: 0 }, advice: null }))
      .toThrow('原导出条目无效')
  })
})
