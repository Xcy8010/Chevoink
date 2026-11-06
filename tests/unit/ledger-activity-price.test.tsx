// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import LedgerActivityPrice from '../../src/features/account/LedgerActivityPrice'
import type { CreditLedgerItem } from '../../shared/contracts'
afterEach(cleanup)
const row: CreditLedgerItem={id:'synthetic',delta:-1,kind:'usage',sourceType:'model_tokens',referenceId:null,modelTier:'speed',multiplier:0.0001,baseMultiplier:1,requestTokens:1,responseTokens:0,promptCacheHitTokens:null,promptCacheMissTokens:null,createdAt:'2026-11-06T10:00:00Z',activity:{id:'public-activity',name:'自定义活动',revision:1,timezone:'Asia/Shanghai',admittedAt:'2026-11-06T10:00:00Z'}}
it('shows the ORIGINAL custom activity, precise base/effective price and explicit timezone',()=>{render(<LedgerActivityPrice item={row}/>);expect(screen.getByText(/自定义活动/).textContent).toContain('1x → 0.0001x');expect(screen.getByText(/自定义活动/).textContent).toContain('Asia/Shanghai');expect(screen.getByText(/自定义活动/).textContent).not.toContain('0.0x')})
it('legacy rows without frozen activity keep their existing ledger presentation',()=>{const {container}=render(<LedgerActivityPrice item={{...row,activity:undefined}}/>);expect(container.textContent).toBe('')})
