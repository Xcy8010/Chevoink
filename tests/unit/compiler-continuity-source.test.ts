import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { readCompilerContinuitySource, compilerContinuitySourceScope } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe('bounded compiler source identity', () => {
  const chapter = { id: 'current', title: '当前', revision: 1, content: '当前正文', orderIndex: 5 }
  const rows = [4, 3, 2].map(orderIndex => ({ id: `c${orderIndex}`, title: `前章${orderIndex}`, revision: 1, orderIndex, content: `第${orderIndex}章事实。` }))
  it('binds exact order, full hashes, clipped ranges and the original bridge source', async () => {
    const bridge = { id: 'c4', revision: 1, content: rows[0].content }
    const long = { ...rows[2], content: '😀' + '甲'.repeat(12_100) }
    const findMany = vi.fn().mockResolvedValue([rows[0], rows[1], long])
    const db = { chapter: { findFirst: vi.fn().mockResolvedValue(bridge), findMany } } as unknown as Prisma.TransactionClient
    const source = await readCompilerContinuitySource(db, { userId: 'u', novelId: 'n' }, chapter, bridge.id)
    expect(source).toMatchObject({ revision: 1, bridgeSource: bridge, preceding: [
      { id: 'c2', start: 102, end: 12_102, totalChars: 12_102, truncated: true, joinedStart: 0, joinedEnd: 12_000 },
      { id: 'c3', joinedStart: 12_002 }, { id: 'c4' },
    ] })
    expect(source?.content).toBe([long.content.slice(-12_000), rows[1].content, rows[0].content].join('\n\n'))
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ authorId: 'u', novelId: 'n', orderIndex: { lt: 5 } }), take: 3 }))
    expect(compilerContinuitySourceScope(source)).toContain('未提供部分未核验')
    const before = runtimeJson(source).hash
    findMany.mockResolvedValue([rows[0], rows[1], { ...long, content: '🙂' + long.content.slice(2) }])
    const changed = await readCompilerContinuitySource(db, { userId: 'u', novelId: 'n' }, chapter, bridge.id)
    expect(changed?.content).toBe(source?.content)
    expect(runtimeJson(changed).hash).not.toBe(before)
  })
  it.each([6, 7] as const)('keeps frozen protocol %s single-source bytes and avoids expanding its query', async protocol => {
    const source = { id: 'c4', revision: 1, content: '原冻结前文' }, findMany = vi.fn()
    const db = { chapter: { findFirst: vi.fn().mockResolvedValue(source), findMany } } as unknown as Prisma.TransactionClient
    expect(await readCompilerContinuitySource(db, { userId: 'u', novelId: 'n' }, chapter, source.id, protocol)).toEqual(source)
    expect(findMany).not.toHaveBeenCalled()
    const old = compilerContinuityCoverage({ chapter, bridge: {}, sceneTasks: [], source }, protocol)
    expect(old.protocolVersion).toBe(protocol)
    expect(old.reviewHash).not.toBe(compilerContinuityCoverage({ chapter, bridge: {}, sceneTasks: [], source }).reviewHash)
  })
})
