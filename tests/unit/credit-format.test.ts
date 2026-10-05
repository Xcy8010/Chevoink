import { describe, expect, it } from 'vitest'

import { formatCreditAmount, roundCreditAmount } from '../../src/features/account/credit-format.js'
import { ledgerLabel } from '../../src/features/account/ledger-label.js'
import type { CreditLedgerItem } from '../../shared/contracts/credits.js'

describe('user-visible Credits formatting', () => {
  it('shows a dynamic product name with a compatible fallback for historical missing configuration', () => {
    const entry = { kind: 'usage', sourceType: 'model_tokens', modelTier: 'builtin_0123456789abcdef', modelLabel: '动态名称' } as CreditLedgerItem
    expect(ledgerLabel(entry)).toBe('动态名称')
    expect(ledgerLabel({ ...entry, modelLabel: undefined })).toBe('文本模型')
    expect(ledgerLabel({ ...entry, kind: 'refund' })).toBe('失败调用返还')
  })
  it('never exposes fractional Credits', () => {
    expect(roundCreditAmount(12.49)).toBe(12)
    expect(roundCreditAmount(12.5)).toBe(13)
    expect(formatCreditAmount(1234.56)).toBe('1,235')
  })

  it('normalizes invalid and negative-zero values', () => {
    expect(roundCreditAmount(Number.NaN)).toBe(0)
    expect(Object.is(roundCreditAmount(-0.1), -0)).toBe(false)
  })
})
