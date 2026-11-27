import { describe, expect, it } from 'vitest'
import { stopAccountCoverRequests, withCoverRequest } from '../../api/lib/governance-cover-requests.js'
import { assessSafety } from '../../api/lib/governance-safety.js'
import { issueRestrictionsSchema } from '../../shared/contracts/governance-restrictions.js'

describe('governance policy boundaries',()=>{
  const now = new Date('2026-11-28T00:00:00Z')
  const events = (n:number,status='confirmed',evasion='none')=>Array.from({length:n},(_,i)=>({id:String(i),createdAt:now,status,evasion}))
  it('未复核信号、正常高频与已纠正事件不能升级，窗口以原始动作时间为准',()=>{
    expect(assessSafety(events(1200,'pending','high'),30,now).level).toBe('record')
    expect(assessSafety(events(8,'dismissed','high'),30,now).level).toBe('record')
    expect(assessSafety(events(80),30,now).level).toBe('record')
    expect(assessSafety(events(3,'confirmed','credible'),30,now).level).toBe('warning')
    expect(assessSafety(events(5,'confirmed','high'),30,now).level).toBe('platform')
    const old=events(5,'confirmed','high').map(e=>({...e,createdAt:new Date(+now-30*86400_000-1)}))
    expect(assessSafety(old,30,now).level).toBe('record')
  })
  it('只中止受限用户在途的封面请求',async()=>{
    await withCoverRequest('owner',undefined,async owner=>
      withCoverRequest('other',undefined,async other=>{
        stopAccountCoverRequests('owner')
        expect(owner.aborted).toBe(true)
        expect(other.aborted).toBe(false)
      }))
    await withCoverRequest('owner',undefined,async next=>{expect(next.aborted).toBe(false)})
  })
  it('全平台人工处置须显式确认',()=>{
    const body={userId:'owned',scopes:['platform'],reason:'合成原因',clause:'合成条款',expiresAt:null}
    expect(issueRestrictionsSchema.safeParse(body).success).toBe(false)
    expect(issueRestrictionsSchema.safeParse({...body,confirmPlatform:true}).success).toBe(true)
  })
})
