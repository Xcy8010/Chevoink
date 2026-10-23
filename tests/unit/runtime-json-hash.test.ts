import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runtimeJson, runtimeJsonHash } from '../../api/lib/agent/runtime-common.js'
import { DataAccessError } from '../../api/lib/prisma.js'

describe('frozen runtime JSON verification without a discarded snapshot copy', () => {
  it.each([
    [{ z: 1, a: [true, null, '原地\n"'] }, String.raw`{"a":[true,null,"原地\n\""],"z":1}`],
    [{ '2': 2, '10': 'ten', a: -0 }, '{"10":"ten","2":2,"a":0}'],
    [['\ud800', '\\', 1e-7], '["\\ud800","\\\\",1e-7]'],
    ['原始文本', '"原始文本"'], [false, 'false'], [12.5, '12.5'],
  ] as const)('preserves the original canonical bytes and SHA for %j', (value, canonical) => {
    const expected = createHash('sha256').update(canonical).digest('hex')
    expect(runtimeJsonHash(value)).toBe(expected)
    expect(runtimeJson(value)).toEqual({ value: JSON.parse(canonical), hash: expected })
  })

  it.each([undefined, null, NaN, Infinity, 1n, () => {}, new Date(0), Object.create(null), [undefined], new Array(1)])(
    'keeps the original invalid-input rejection for case %#', value => {
      for (const read of [runtimeJson, runtimeJsonHash]) {
        let observed: unknown
        try { read(value) } catch (error) { observed = error }
        expect(observed).toBeInstanceOf(DataAccessError)
        expect(observed).toMatchObject({ code: 'RUNTIME_INPUT_INVALID' })
      }
    })

  it('retains depth and UTF-8 payload bounds without mutating the source', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 33; depth++) nested = [nested]
    expect(() => runtimeJsonHash(nested)).toThrow()
    expect(() => runtimeJson(nested)).toThrow()
    for (const read of [runtimeJson, runtimeJsonHash]) {
      let observed: unknown
      try { read('中'.repeat(700_000)) } catch (error) { observed = error }
      expect(observed).toMatchObject({ code: 'RUNTIME_PAYLOAD_TOO_LARGE' })
    }
    const source = Object.freeze({ state: Object.freeze(['原文', 1]) })
    expect(runtimeJsonHash(source)).toBe(runtimeJson(source).hash)
    expect(source.state).toEqual(['原文', 1])
  })
})
