import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyTerminalCandidatePatch, readFrozenLegacyTerminalPatch, terminalCandidatePatchSchema } from '../../api/lib/agent/terminal-candidate-patch.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe.runIf(available)('candidate delta at the original PostgreSQL compiler lock', () => {
  it('recovers an applied same-call delta and refuses a stale new call or same-body unknown overwrite', () => fixture(async f => {
    const fetcher = vi.fn(() => { throw Error('Unexpected provider request') })
    vi.stubGlobal('fetch', fetcher)
    const chapter = await prisma.chapter.update({where:{id:f.chapterId},data:{content:'The officer inventories a sealed crate.',revision:15}})
    const {compilation} = await prepareStoryCompilation({...f,chapterId:chapter.id,mode:'balanced',intentSummary:'Review this saved synthetic chapter.'})
    const empty = terminalCandidateSchema.parse({exitState:{}}).exitState
    await saveSceneTasks({...f,compilationId:compilation.id,tasks:[{purpose:'Inventory',entryState:empty,goal:'Record',obstacle:'Seal',choice:'Read',cost:'Time',turn:'Recorded',exitState:empty,styleBudget:{description:'low',dialogue:'low',rhetoric:'low'}}]})
    const saved = await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilation.id},include:{bridge:true,sceneTasks:true}})
    const source = await readCompilerContinuitySource(prisma,f,chapter,saved.bridge!.fromChapterId,11)
    const base = terminalCandidateSchema.parse({exitState:{knowledge:['The manifest might be missing.'],objects:['The crate is sealed.']}})
    const write = async (candidate:typeof base) => {
      const current = await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilation.id}})
      const evidence = terminalEvidenceContext(chapter,source,2,1,terminalCoverageInput(f.spec,current.preparedContext,chapter,candidate,2),4)
      const raw = JSON.stringify({findings:[],semanticChecks:Object.fromEntries(['action_direction','state_progression'].map(kind=>[kind,{result:'clear',reason:'Checked the complete saved body.',findingIndexes:[]}])),
        terminalVerdicts:[...candidate.exitState.knowledge.map(claim=>({factId:terminalFactId('knowledge',claim),verdict:'unknown',sourceEvidence:[]})),{factId:terminalFactId('objects',candidate.exitState.objects[0]),verdict:'supported',sourceEvidence:[{segmentId:'c0'}]}],terminalDispositions:[],terminalProofVerdicts:[]})
      const inspected = inspectContinuityResponse(raw,{previous:source?.content??null,current:chapter.content,terminalEvidence:evidence},true,8,candidate)
      expect(inspected.complete).toBe(true)
      // Synthetic pre-refactor state, interpreted only by the frozen reader.
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ terminalCandidate: candidate,
        continuityCriticResponse: inspected.audit, checkedRevision: 15, independentCheck: 'complete' }).value } })
      return persistCurrentContinuityReport({ ...f, compilationId: compilation.id, expectedChapterRevision: 15 })
    }
    await write(base)
    const ctx = {...f,callId:'delta-owned',signal:new AbortController().signal}
    const patch = terminalCandidatePatchSchema.parse({baseCandidateHash:runtimeJson(base).hash,removeFactIds:[terminalFactId('knowledge',base.exitState.knowledge[0])],addFacts:[{field:'knowledge',claim:'The manifest status is uncertain.'}]})
    const original = await readOriginalTaskRequest(prisma, ctx), candidate = applyTerminalCandidatePatch(base, patch)
    const snapshot = { version: 1, kind: 'terminalCandidatePatch', identity: { userId: f.userId, novelId: f.novelId,
      taskId: original.taskId, runId: f.runId, callId: ctx.callId, compilationId: compilation.id, chapterId: chapter.id, revision: 15,
      bodyHash: runtimeJson({ content: chapter.content }).hash, sourceHash: runtimeJson({ source: source ?? null }).hash },
      request: { patch, inheritedProofs: [] }, base, candidate }
    const snapshotId = runtimeJson({ kind: 'terminalCandidatePatch', runId: f.runId, callId: ctx.callId, compilationId: compilation.id }).hash
    const historical = await prisma.agentArtifact.create({ data: { id: snapshotId, runId: f.runId, artifactType: 'continuityReview',
      title: '冻结历史增量', content: JSON.stringify(snapshot), metadata: runtimeJson(snapshot).value } })
    const read = (callId=ctx.callId) => prisma.$transaction(async tx => {
      const current = await tx.storyCompilation.findUniqueOrThrow({where:{id:compilation.id},include:{chapter:true}})
      return readFrozenLegacyTerminalPatch(tx,{...ctx,callId},{...current,chapter:current.chapter!},source,[],2,patch)
    })
    const frozen = (await read())!
    await write(frozen.candidate)
    const artifacts = await prisma.agentArtifact.count({where:{runId:f.runId,artifactType:'continuityReview'}})
    expect(await read()).toEqual({candidate:frozen.candidate,expectedBaseHash:runtimeJson(frozen.candidate).hash})
    expect(await prisma.agentArtifact.count({where:{runId:f.runId,artifactType:'continuityReview'}})).toBe(artifacts)
    expect(await read('new-call')).toBeNull()
    const concurrent = terminalCandidateSchema.parse({exitState:{...frozen.candidate.exitState,knowledge:['A different unresolved hypothesis.']}})
    await write(concurrent)
    const before = await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilation.id}})
    await expect(read()).rejects.toMatchObject({code:'CONTINUITY_INPUT_STALE'})
    expect(await prisma.storyCompilation.findUniqueOrThrow({where:{id:compilation.id}})).toEqual(before)
    expect(await prisma.chapter.findUniqueOrThrow({where:{id:chapter.id}})).toMatchObject({content:chapter.content,revision:15})
    expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
    await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 16, content: chapter.content + ' The officer leaves.' } })
    const changed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    await expect(persistCurrentContinuityReport({ ...f, compilationId: compilation.id, expectedChapterRevision: 15 })).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(changed)
    expect(await prisma.aiUsageLog.count({where:{agentRunId:f.runId}})).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  },undefined,'修改本章',{continuityEvidenceProtocol:1,terminalEvidenceProtocol:2,terminalQuoteAddressProtocol:1,terminalCoverageProtocol:1}),30000)
})
