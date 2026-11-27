import { expect,it } from 'vitest'
import { compareGovernanceReceipt, uniqueGatewayLink } from '../../api/lib/governance-reconciliation'
import { yunshuResponseId } from '../../api/lib/yunshu-request-link'
import { calculateV1ChargeMilli, calculateV2UserChargeMilli } from '../../api/lib/billing/pricing'
const row = { id:'remote',createdAt:'2026-11-01',modelName:'synthetic',group:null,kind:'consume' as const,requestId:'r',requestTokens:100,responseTokens:20,durationMs:null,streamOutcome:'unknown' as const,quota:'999999999' }
const milli=calculateV1ChargeMilli(100,20,10000)
const local={owner:'user',actionId:'one',key:'usage:one',price:null,multiplier:10000,settled:true,input:100,output:20,cache:null,reported:true,recordedCharge:milli,exempt:false,reserved:false}
const ledger={userId:'user',deltaMilli:-milli,metadata:null,refundIntent:null}
it('matches exact evidence using the historical formula independently of upstream quota',()=>{
  expect(compareGovernanceReceipt(row,local,ledger,null)).toMatchObject({state:'matched',expectedMilli:milli})
  expect(compareGovernanceReceipt(row,{...local,recordedCharge:milli+1},ledger,null).state).toBe('difference')
  expect(compareGovernanceReceipt({...row,requestTokens:0,responseTokens:0},{...local,input:0,output:0,recordedCharge:0},null,null).state).toBe('matched')
})
it('keeps unknown, failed, reserved, refund and shared-token observations distinct',()=>{
  expect(compareGovernanceReceipt(row,null,null,null)).toMatchObject({state:'unknown',userId:null})
  expect(compareGovernanceReceipt({...row,kind:'error'},local,null,null).state).toBe('provider_error')
  expect(compareGovernanceReceipt(row,{...local,reserved:true},null,null).state).toBe('pending')
  expect(compareGovernanceReceipt(row,local,ledger,{userId:'user',deltaMilli:milli}).state).toBe('refunded')
  expect(compareGovernanceReceipt(row,local,{...ledger,userId:'else'},null).state).toBe('unknown')
  expect(compareGovernanceReceipt(row,{...local,price:{broken:true}},ledger,null).state).toBe('unknown')
})
it('accepts a gateway-issued ID only from the canonical response endpoint',()=>{
  const id='1'.repeat(23)+'a'.repeat(16)
  const response=new Response(null,{headers:{'x-oneapi-request-id':id}})
  Object.defineProperty(response,'url',{value:'https://yunshu.chevolink.com/v1/chat/completions',configurable:true})
  expect(yunshuResponseId(response)).toBe(id)
  Object.defineProperty(response,'url',{value:'https://synthetic.invalid/v1/chat/completions'})
  expect(yunshuResponseId(response)).toBeNull()
})

it('uses a frozen itemized card, including the original unknown-cache concession',()=>{
  const rates={inputNano:300000,cacheNano:30000,outputNano:800000}
  const price={version:'credits-v2-itemized',modelTier:'speed',multiplierBps:10000,rateCardId:'frozen',rates}
  const expected=calculateV2UserChargeMilli(100,20,null,rates)
  expect(compareGovernanceReceipt(row,{...local,price,cache:60,recordedCharge:expected},{...ledger,deltaMilli:-expected,metadata:{cachePricingPolicy:'unknown-cache-discount-2026-09-09'}},null)).toMatchObject({state:'matched',expectedMilli:expected})
  expect(compareGovernanceReceipt(row,{...local,key:'operation:1'},ledger,null).state).toBe('unknown')
})
it('does not pair a retry, duplicate association or shared token without a unique dispatch in both directions',()=>{
  const one={kind:'usage',localId:'one',requestId:'gateway-1'}
  expect(uniqueGatewayLink([one],[one],one.requestId)).toBe(one)
  expect(uniqueGatewayLink([one],[one,{requestId:'gateway-2'}],one.requestId)).toBeNull()
  expect(uniqueGatewayLink([one,{...one,localId:'two'}],[one],one.requestId)).toBeNull()
  expect(uniqueGatewayLink([],[],null)).toBeNull()
})

it('preserves uncertainty when the gateway repeats a consumption ID or its cache evidence disagrees', () => {
  expect(compareGovernanceReceipt({ ...row, ambiguousConsumption: true }, local, ledger, null)).toMatchObject({ state: 'unknown', userId: null })
  expect(compareGovernanceReceipt({ ...row, cacheHitTokens: 90 }, { ...local, cache: 60 }, ledger, null).state).toBe('unknown')
})
