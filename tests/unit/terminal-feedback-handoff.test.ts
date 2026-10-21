import { expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { terminalFeedbackSlots } from '../../api/lib/agent/terminal-feedback-handoff.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

function fixture() {
  const taskSpec = buildTaskSpec({runId:'original',novelId:'novel',chapterId:'chapter',prompt:'修改本章'})
  taskSpec.scope.writing={version:1,kind:'bounded',targets:[{orderIndex:5,chapterId:'chapter'}],titleAndBodyOnly:false,repairAuthorized:true}
  const subject={userId:'owner',novelId:'novel',taskSpec}
  const review:ChapterReviewReadiness={ready:true,checksRequired:true,compilationId:'compiler',chapterId:'chapter',revision:15,
    continuity:'complete',quality:'complete',continuityErrorCount:0,qualityErrorCount:0,requiredTools:[],continuityExhausted:false,qualityReportId:'synthetic-quality',
    terminalReview:{state:'unverified',unresolved:[{path:'factCoverage.pending',verdict:'unknown'}]},
    progressEvidence:{taskId:taskSpec.id,userId:'owner',novelId:'novel',chapterId:'chapter',orderIndex:5,contentHash:'a'.repeat(64),phases:['continuity','terminal']}}
  return {subject,review}
}

it('retains a fixed four-receipt processing sequence through checkpoints and new reports, without progress or proof promotion',()=>{
  const {subject,review}=fixture(),slots=terminalFeedbackSlots(review,subject)!
  expect(slots).toHaveLength(4)
  expect(new Set(slots).size).toBe(4)
  expect(slots.every(key=>/^[a-f0-9]{64}$/.test(key))).toBe(true)
  const consumed=new Set(slots.slice(0,2)),restored=new Set(JSON.parse(JSON.stringify([...consumed])) as string[])
  const changedReport={...review,revision:99,compilationId:'another',terminalReview:{state:'unverified' as const,unresolved:[{path:'exitState.openLoops.9',verdict:'unknown'}]}}
  expect(terminalFeedbackSlots(changedReport,subject)).toEqual(slots)
  expect(terminalFeedbackSlots(changedReport,subject)!.filter(key=>!restored.has(key))).toEqual(slots.slice(2))
  expect(review.terminalReview?.state).toBe('unverified')
  expect(review.progressEvidence?.phases).not.toContain('terminal_supported')
})

it('requires a current complete terminal judgment inside the original owner and writing scope',()=>{
  const {subject,review}=fixture()
  expect(terminalFeedbackSlots({...review,continuity:'incomplete'},subject)).toBeNull()
  expect(terminalFeedbackSlots({...review,terminalReview:{state:'unverified',unresolved:[]}},subject)).toBeNull()
  expect(terminalFeedbackSlots({...review,terminalReview:{state:'supported',unresolved:[]}},subject)).toBeNull()
  for(const patch of [{phases:['continuity'] as const},{taskId:'other'},{userId:'other'},{novelId:'other'},
    {chapterId:'other'},{orderIndex:6},{contentHash:'invalid'}]) {
    expect(terminalFeedbackSlots({...review,progressEvidence:{...review.progressEvidence!,...patch,phases:[...('phases' in patch?patch.phases:review.progressEvidence!.phases)]}},subject)).toBeNull()
  }
  expect(terminalFeedbackSlots(review,{...subject,userId:'other'})).toBeNull()
  expect(terminalFeedbackSlots(review,{...subject,taskSpec:{...subject.taskSpec,writingPacing:'proposal_only'}})).toBeNull()
  const otherBody={...review,progressEvidence:{...review.progressEvidence!,contentHash:'b'.repeat(64)}}
  expect(terminalFeedbackSlots(otherBody,subject)).not.toEqual(terminalFeedbackSlots(review,subject))
})
