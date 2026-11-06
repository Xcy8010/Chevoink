import { expect, it } from 'vitest'
import { appReleasePeriods, formatAppReleaseTime } from '../../shared/app-release-periods'
import type { AppReleaseReceipt } from '../../shared/contracts/app-release'
const receipt=(action:AppReleaseReceipt['action'],releaseId:string,appliedAt:string,previousReleaseId:string|null=null):AppReleaseReceipt=>({action,releaseId,appliedAt,previousReleaseId,operationId:appliedAt,status:'applied',revision:1})
it('shows Beijing date and exact seconds across the UTC day boundary',()=>{
 expect(formatAppReleaseTime('2026-11-06T21:20:34.616Z')).toBe('2026-11-07 05:20:34')
 expect(formatAppReleaseTime('2026-11-06T16:00:00Z')).toBe('2026-11-07 00:00:00')
})
it('derives real test and stable intervals and closes test when the version becomes stable',()=>{
 const periods=appReleasePeriods([
  receipt('full_release','A','2026-11-06T19:26:21Z'),
  receipt('assign_test','B','2026-11-06T19:31:21Z'),
  receipt('full_release','B','2026-11-06T20:03:34Z','A'),
  receipt('full_release','B','2026-11-06T20:04:10Z','B'),
  receipt('assign_test','C','2026-11-06T21:07:21Z','B'),
  receipt('full_release','C','2026-11-06T21:20:34Z','B'),
 ])
 expect(periods.get('B')).toEqual([
  {channel:'test',startsAt:'2026-11-06T19:31:21Z',endsAt:'2026-11-06T20:03:34Z'},
  {channel:'stable',startsAt:'2026-11-06T20:03:34Z',endsAt:'2026-11-06T21:20:34Z'},
 ])
 expect(periods.get('C')).toEqual([
  {channel:'test',startsAt:'2026-11-06T21:07:21Z',endsAt:'2026-11-06T21:20:34Z'},
  {channel:'stable',startsAt:'2026-11-06T21:20:34Z',endsAt:null},
 ])
})
it('closes a withdrawn test and leaves it closed across a stable rollback',()=>{
 const periods=appReleasePeriods([
  receipt('full_release','A','2026-11-06T01:00:00Z'),
  receipt('assign_test','B','2026-11-06T02:00:00Z'),
  receipt('withdraw_test','B','2026-11-06T03:00:00Z','B'),
  receipt('rollback','C','2026-11-06T04:00:00Z','A'),
 ])
 expect(periods.get('B')).toEqual([{channel:'test',startsAt:'2026-11-06T02:00:00Z',endsAt:'2026-11-06T03:00:00Z'}])
 expect(periods.get('C')).toEqual([{channel:'stable',startsAt:'2026-11-06T04:00:00Z',endsAt:null}])
})
it('never presents a discarded candidate as an applied stable interval',()=>{
 const periods=appReleasePeriods([receipt('full_release','A','2026-11-06T01:00:00Z'),receipt('discard_candidate','draft','2026-11-06T02:00:00Z')])
 expect(periods.has('draft')).toBe(false)
 expect(periods.get('A')).toEqual([{channel:'stable',startsAt:'2026-11-06T01:00:00Z',endsAt:null}])
})
it('does not invent a missing historical start or discard intervals older than fifty operations',()=>{
 const records=[receipt('full_release','A','2026-11-06T00:00:00Z','unknown')]
 for(let i=1;i<=60;i++)records.push(receipt('assign_test','test-'+i,new Date(Date.parse('2026-11-06T00:00:00Z')+i*1000).toISOString(),i===1?null:'test-'+(i-1)))
 const periods=appReleasePeriods(records.reverse())
 expect(periods.get('unknown')).toEqual([{channel:'stable',startsAt:null,endsAt:'2026-11-06T00:00:00Z'}])
 expect(periods.get('A')?.[0].startsAt).toBe('2026-11-06T00:00:00Z')
 expect(periods.get('test-1')?.[0].endsAt).toBe('2026-11-06T00:00:02.000Z')
})
