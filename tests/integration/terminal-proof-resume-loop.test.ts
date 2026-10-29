import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite } from '../../api/lib/agent/story-compiler.js'
import { persistHistoricalContinuityAudit as validateStoryContinuity, persistHistoricalCommittedBridge } from '../support/historical-continuity-audit.js'
import { continueCurrentTerminalLoop as continueCurrentReviewWorkflow } from '../support/current-terminal-loop-fixture.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { observeChapterReviewProgress, observeSemanticReadProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as credits from '../../api/lib/credits.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'

const fixture: typeof durableFixture = (work,...rest)=>durableFixture(async f=>{
  try {await work(f)} finally {await prisma.aiUsageLog.deleteMany({where:{userId:f.userId}})}
},...rest)
const checks=['action_direction','state_progression'].map(kind=>({kind,result:'not_applicable',reason:'Synthetic full-body continuity judgment.',findingIndexes:[]}))
const empty=terminalCandidateSchema.parse({exitState:{}}).exitState
type Subject={userId:string;novelId:string;runId:string}
type Chapter={id:string;content:string;revision:number;orderIndex:number}
async function prepare(subject:Subject,chapter:Chapter){
  const {compilation}=await prepareStoryCompilation({...subject,chapterId:chapter.id,mode:'balanced',intentSummary:'Review the synthetic saved chapter.'})
  await saveSceneTasks({...subject,compilationId:compilation.id,tasks:[{purpose:'Record the saved action',entryState:empty,goal:'Inventory',obstacle:'Sealed crate',choice:'Record',cost:'Time',turn:'Recorded',exitState:empty,styleBudget:{description:'low',dialogue:'low',rhetoric:'low'}}]})
  return compilation.id
}
async function saveReview(subject:Subject,chapter:Chapter,compilationId:string,candidate:ReturnType<typeof terminalCandidateSchema.parse>,parts:Record<string,unknown>){
  const compilation=await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilationId},include:{bridge:true,sceneTasks:true}})
  const original=await prisma.$transaction(tx=>readOriginalTaskRequest(tx,subject))
  const source=await readCompilerContinuitySource(prisma,subject,chapter,compilation.bridge!.fromChapterId,11)
  const evidence=terminalEvidenceContext(chapter,source,2,1,terminalCoverageInput(original.spec,compilation.preparedContext,chapter,candidate,2),2)
  const raw=JSON.stringify({findings:[],semanticChecks:checks,...parts})
  const inspected=inspectContinuityResponse(raw,{previous:source?.content??null,current:chapter.content,terminalEvidence:evidence},true,8,candidate)
  expect(inspected.complete).toBe(true)
  await validateStoryContinuity({...subject,compilationId,expectedChapterRevision:chapter.revision,independentCheck:'complete',findings:[],terminalCandidate:candidate,
    coverage:compilerContinuityCoverage({chapter,bridge:compilation.bridge,sceneTasks:compilation.sceneTasks,source,terminalCandidate:candidate},11),continuityCriticResponse:inspected.audit})
  return evidence
}

describe.runIf(available)('historical proof selections remain immutable while current prose reports can complete',()=>{
  it('does not issue a supported-progress milestone for an empty candidate and empty obligation set',()=>fixture(async f=>{
    const chapter=await prisma.chapter.update({where:{id:f.chapterId},data:{content:'The crate is sealed.',revision:1}})
    const compilationId=await prepare(f,chapter),candidate=terminalCandidateSchema.parse({exitState:{}})
    await saveReview(f,chapter,compilationId,candidate,{terminalVerdicts:[],terminalDispositions:[]})
    const readiness=await prisma.$transaction(tx=>readChapterReviewReadiness(tx,f,compilationId))
    expect(readiness).toMatchObject({ ready: false, continuity: 'stale' })
    expect(readiness?.progressEvidence?.phases).not.toContain('continuity')
    expect(readiness?.progressEvidence?.phases).not.toContain('terminal')
    const historical = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
    expect((historical.validation as { terminalCandidate: unknown }).terminalCandidate).toEqual(candidate)
    expect(await prisma.aiUsageLog.count({where:{agentRunId:f.runId}})).toBe(0)
  },undefined,'修改本章',{continuityEvidenceProtocol:1,terminalEvidenceProtocol:2,terminalQuoteAddressProtocol:1,terminalCoverageProtocol:1}))
  it.each(['unchanged','seen-supported','fresh-context','changed','uncertain','alias-unknown','interrupted','patch'] as const)('keeps ownership, costs and unknown protection: %s',scenario=>fixture(async f=>{
    vi.spyOn(memory,'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory,'syncNovelMemoryProjection').mockResolvedValue({chapterCount:0,jobCount:0,entityCount:0,relationCount:0,reused:false})
    vi.spyOn(titles,'autoNameSession').mockResolvedValue(undefined)
    await prisma.agentRun.update({where:{id:f.runId},data:{runtimeProtocolVersion:0,taskRootId:null,startRequest:{prompt:'修改本章'}}})
    let chapter=await prisma.chapter.update({where:{id:f.chapterId},data:{orderIndex:2,orderInVolume:2,revision:14,content:'The pump repair still awaits a replacement seal.'}})
    const claim=chapter.content,canonical=terminalCandidateSchema.parse({exitState:{openLoops:[claim]}})
    const previous=await prisma.chapter.create({data:{authorId:f.userId,novelId:f.novelId,volumeId:chapter.volumeId,title:'Synthetic predecessor',orderIndex:1,orderInVolume:1,revision:1,content:claim,wordCount:claim.length}})
    const priorRun=randomUUID(),prior={userId:f.userId,novelId:f.novelId,runId:priorRun}
    await prisma.agentRun.create({data:{id:priorRun,userId:f.userId,novelId:f.novelId,sessionId:f.sessionId,chapterId:previous.id,status:'running',mode:'act',action:'workspaceAgent',agentType:'writingOrchestrator',engine:'loop',runtimeProtocolVersion:0,
      taskSpec:JSON.parse(JSON.stringify(buildTaskSpec({runId:priorRun,novelId:f.novelId,chapterId:previous.id,prompt:'修改本章',continuityEvidenceProtocol:1,terminalEvidenceProtocol:2,terminalQuoteAddressProtocol:1,terminalCoverageProtocol:1})))}})
    await prisma.agentMessage.create({data:{runId:priorRun,sessionId:f.sessionId,role:'user',parts:[{type:'text',text:'修改本章'}]}})
    const priorId=await prepare(prior,previous)
    await saveReview(prior,previous,priorId,canonical,{terminalVerdicts:[{path:'exitState.openLoops.0',verdict:'supported',sourceEvidence:[{segmentId:'c0',quote:claim}]}],terminalDispositions:[]})
    await persistHumanityQualityReport({...prior,compilationId:priorId,chapterId:previous.id,chapterRevision:1,mode:'balanced',criticComplete:true,criticFindings:[],deterministicFindings:[],deterministicMetrics:{}})
    await persistHistoricalCommittedBridge(priorId)
    const predecessorReceipt = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: priorId }, include: { bridge: true, sceneTasks: true } })
    const compilationId=await prepare(f,chapter)
    const aliases=terminalCandidateSchema.parse({exitState:{openLoops:['The pump repair.','The replacement seal is outstanding.'],emotion:['The officer is relieved.']}})
    await saveReview(f,chapter,compilationId,aliases,{terminalVerdicts:[...aliases.exitState.openLoops.map((_,index)=>({path:`exitState.openLoops.${index}`,verdict:'supported',sourceEvidence:[{segmentId:'c0',quote:claim}]})),
      {path:'exitState.emotion.0',verdict:'unknown',sourceEvidence:[]}],terminalDispositions:[]})
    const body='The officer inventories a crate. The crate is sealed.'
    chapter=await prisma.chapter.update({where:{id:f.chapterId},data:{revision:15,content:body,wordCount:body.length}})
    await recordStoryCompilerWrite({...f,chapterOrderIndex:2,chapterRevision:15})
    const base=terminalCandidateSchema.parse({exitState:{objects:['The crate is sealed.'],...(scenario==='patch'?{emotion:['The officer is relieved.']}: {})}})
    const saved=await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilationId}}),original=await prisma.$transaction(tx=>readOriginalTaskRequest(tx,f))
    const obligations=terminalCoverageInput(original.spec,saved.preparedContext,chapter,base,2)!.obligations
    expect(obligations).toHaveLength(2)
    const evidence=await saveReview(f,chapter,compilationId,base,{terminalVerdicts:[{path:'exitState.objects.0',verdict:'supported',sourceEvidence:[{segmentId:'c0',quote:'The crate is sealed.'}]},...(scenario==='patch'?[{path:'exitState.emotion.0',verdict:'unknown',sourceEvidence:[]}]:[])],
      terminalDispositions:obligations.map(({id})=>({id,outcome:'unknown',reason:'Prior obligation retained; no fresh persistence judgment yet.',sourceEvidence:[]}))})
    const proof=evidence.previous!.carried!.find(fact=>fact.field==='openLoops'&&fact.claim===claim)!
    expect(proof.depth).toBe(1)
    await persistHumanityQualityReport({...f,compilationId,chapterId:chapter.id,chapterRevision:15,mode:'balanced',criticComplete:true,criticFindings:[],deterministicFindings:[],deterministicMetrics:{}})
    const spec=await prisma.$transaction(tx=>freezeWritingScope(tx,f,original.spec as typeof f.spec,'修改本章'))
    await prisma.agentRun.update({where:{id:f.runId},data:{taskSpec:JSON.parse(JSON.stringify(spec))}})
    const readiness=await prisma.$transaction(tx=>readChapterReviewReadiness(tx,f,compilationId)),seen=new Set<string>()
    expect(readiness).toMatchObject({ ready: false, continuity: 'stale' })
    expect(observeChapterReviewProgress(seen,readiness?.progressEvidence,{...f,taskSpec:spec,expectedOriginalTaskId:original.taskId})).toBe(false)
    if(scenario==='seen-supported') seen.add(`review:${JSON.stringify([f.userId,f.novelId,original.taskId,chapter.id,runtimeJson({ content: body }).hash,'terminal_supported'])}`)
    observeSemanticReadProgress(seen,'chapter_read',body,{targetId:chapter.id,contentHash:createHash('sha256').update(body).digest('hex'),start:0,end:body.length})
    for(const phase of ['prepare','scenes'] as const) expect(observeWritingWorkflowMilestone(seen,
      phase==='prepare'?'story_compiler_prepare':'scene_task_build',
      {version:1,userId:f.userId,novelId:f.novelId,runId:f.runId,targetOrderIndex:2,phase},{...f,taskSpec:spec})).toBe(true)
    const handoff = Array.from({ length: 4 }, (_, index) => runtimeJson({ historicalFeedback: compilationId, revision: chapter.revision, index }).hash)
    const started=Date.now()-10000,checkpoint={version:2,controlPolicy:'until_completion',origin:'system_default',activeExecutionMs:200,stagnantBatches:4,runStartedAt:started,resumeCount:0,compactionCount:0,maxTurns:1,tokenBudget:500,writeProgress:1,writeBaseline:0,readProgress:7,readBaseline:0,progressSignatures:[...seen],
      reviewAttempts:['old-attempt',`settled-continuity:${compilationId}:${chapter.id}:15:continuity_validate:protocol8`],
      consumedReviewDecisionFeedback:scenario==='interrupted'?[handoff[0]]:[],inheritedTokens:0,inheritedTurns:0,manualResumeCount:0}
    await prisma.agentRun.update({where:{id:f.runId},data:{status:'paused',currentTurn:22,startedAt:new Date(started),usage:{promptTokens:10,completionTokens:3,totalTokens:13,checkpoint}}})
    await prisma.agentRunEvent.createMany({data:[{runId:f.runId,seq:1,type:'run.started',payload:{}},{runId:f.runId,seq:2,type:'tool.call',payload:{toolName:'continuity_validate',callId:'old-review',args:{compilationId}}},
      {runId:f.runId,seq:3,type:'tool.result',payload:{toolName:'continuity_validate',callId:'old-review',ok:false,failureCode:'TERMINAL_STATE_REVIEW_REQUIRED'}},{runId:f.runId,seq:4,type:'run.paused',payload:{reason:'model_stalled'}}]})
    const history=await prisma.agentRunEvent.findMany({where:{runId:f.runId},orderBy:{seq:'asc'}}),window=credits.getCreditWindow()
    await prisma.creditAccount.create({data:{userId:f.userId,dailyAllowanceMilli:100000,periodStartedAt:window.startedAt,periodEndsAt:window.endsAt}})
    const feature=flags.isAgent2FeatureEnabled
    vi.spyOn(flags,'isAgent2FeatureEnabled').mockImplementation((key,owner)=>key==='storyCompiler'||key!=='memory2'&&feature(key,owner))
    const frozen = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilationId } })
    const completed = await continueCurrentReviewWorkflow(f, { compilationId, prompt: '修改本章', afterSeq: 4, readFirst: scenario === 'fresh-context' || scenario === 'interrupted' })
    expect(await prisma.agentRunEvent.findMany({where:{runId:f.runId,seq:{lte:4}},orderBy:{seq:'asc'}})).toEqual(history)
    expect(completed.chapter.content.trim()).toBe(body)
    expect(completed.chapter.revision).toBe(17)
    const final = await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilationId},include:{bridge:true}})
    const run = await prisma.agentRun.findUniqueOrThrow({where:{id:f.runId}})
    const cp = (run.usage as {checkpoint:typeof checkpoint}).checkpoint
    expect(run.status).toBe('completed')
    expect(final.bridge?.committedAt).not.toBeNull()
    expect((final.validation as { continuityCriticResponse: unknown }).continuityCriticResponse).toEqual((frozen.validation as { continuityCriticResponse: unknown }).continuityCriticResponse)
    expect((final.preparedContext as { terminalFactCoverage: unknown }).terminalFactCoverage).toEqual((frozen.preparedContext as { terminalFactCoverage: unknown }).terminalFactCoverage)
    expect(cp.reviewAttempts).toContain('old-attempt')
    expect(cp.readProgress).toBeGreaterThanOrEqual(7)
    expect(cp.writeProgress).toBeGreaterThan(1)
    expect(cp.progressSignatures).toEqual(expect.arrayContaining(checkpoint.progressSignatures))
    expect(cp.consumedReviewDecisionFeedback ?? []).toEqual(checkpoint.consumedReviewDecisionFeedback)
    expect(cp.progressSignatures.filter(key=>key.endsWith(',"terminal_supported"]')))
      .toEqual(checkpoint.progressSignatures.filter(key=>key.endsWith(',"terminal_supported"]')))
    const ledger = (final.preparedContext as {terminalFactCoverage:{facts:Array<{id:string}>}}).terminalFactCoverage.facts
    for (const obligation of obligations) expect(ledger.some(fact=>fact.id===obligation.id)).toBe(true)
    expect(await prisma.agentRunEvent.count({where:{runId:f.runId,seq:{gt:4},type:'tool.result',payload:{path:['ok'],equals:false}}})).toBe(0)
    const calls = completed.main.mock.calls.length, fees = await prisma.aiUsageLog.count({where:{userId:f.userId}})
    await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
    expect(completed.main).toHaveBeenCalledTimes(calls)
    expect(await prisma.aiUsageLog.count({where:{userId:f.userId}})).toBe(fees)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: priorId }, include: { bridge: true, sceneTasks: true } })).toEqual(predecessorReceipt)
  },undefined,'修改本章',{continuityEvidenceProtocol:1,terminalEvidenceProtocol:2,terminalQuoteAddressProtocol:1,terminalCoverageProtocol:1}),30000)
})
