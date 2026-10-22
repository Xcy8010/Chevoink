import { describe, expect, it, vi } from 'vitest'
import { terminalEvidenceContext, validContinuitySemanticChecks } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, inspectTerminalReview, terminalResponseFields } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts, terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { applyTerminalCandidatePatch, terminalCandidatePatchSchema, freezeLegacyTerminalPatch, readFrozenLegacyTerminalPatch } from '../../api/lib/agent/terminal-candidate-patch.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment, continuityReassessmentRequest, runContinuityReassessment, freshContinuityResponseContract } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as original from '../../api/lib/agent/original-request.js'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'

const chapter = { id: 'current', revision: 15, orderIndex: 5, content: 'The officer inventories a sealed crate.' }
const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The crate is sealed.'], openLoops: ['Repair remains pending.'] } })
const checks = () => Object.fromEntries(['action_direction', 'state_progression'].map(key => [key, { result: 'clear', reason: 'Checked the complete current body.', findingIndexes: [] }]))
const evidence = () => terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: 'task', chapterId: chapter.id, obligations: [] }, 4)
const body = () => ({ previous: null, current: chapter.content, terminalEvidence: evidence() })
const response = (c = candidate) => ({ findings: [], semanticChecks: checks(), terminalProofVerdicts: [], terminalDispositions: [],
  terminalVerdicts: terminalCandidateFacts(c).map(fact => ({ factId: fact.id, verdict: fact.field === 'openLoops' ? 'unknown' : 'supported', sourceEvidence: fact.field === 'openLoops' ? [] : [{ segmentId: 'c0' }] })) })

describe('frozen addressed continuity contract', () => {
  it('keeps the exact pre-patch top-level, nested and earliest frozen tool schema identities', () => {
    expect(originalToolParameterSchemas(continuityValidateTool,{novelId:'fixture'}).map(schema=>runtimeJson(schema).hash)).toEqual(expect.arrayContaining([
      '99b22a9d6e34067638a026bfc4447107b45117d2f7e114f75096a3c54a6502a1',
      'd43fa3541cc42c798c28543946c1bccc6a23305cb07fc598c8fe5921216aaa53',
      '05c988421a7275d7ee7340a98e888b964dfd777017c267255aca3acaee705eee',
      '607c2d0780878a871e2a016aa1e0463883613c093fecc7c1bd4ae809d9b1a7a3',
    ]))
  })
  it('accepts only the new frozen protocol for a map whose exact keys supply missing kinds', async () => {
    const raw = JSON.stringify(response()), bodies = body(), parsed = inspectContinuityResponse(raw, bodies, true, 8, candidate)
    expect(parsed).toMatchObject({ complete: true, audit: { classification: 'complete', terminalEvidence: { verdictProtocol: 4 } } })
    expect(inspectTerminalReview(candidate, chapter.content, raw, true, bodies.terminalEvidence)).toMatchObject({ supported: false, verdicts: [{ verdict: 'supported' }, { verdict: 'unknown' }] })
    // The format change must not erase a genuine unknown or cause another paid pass.
    const dispatch = vi.fn(), claim = vi.fn()
    expect(await runContinuityReassessment({ original: parsed, bodies, system: 'frozen', content: 'frozen', billingKnown: true, providerComplete: true,
      slotUsed: false, signal: new AbortController().signal, assertCurrent: vi.fn(), dispatch, claim })).toBe(parsed)
    expect(dispatch).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled()
    const pathRaw = JSON.stringify({ ...response(), terminalVerdicts: terminalCandidateFacts(candidate).map((fact, index) => ({ ...response().terminalVerdicts[index], factId: undefined, path: fact.path })) })
    for (const version of [undefined, 2, 3] as const) {
      expect(inspectContinuityResponse(pathRaw, { ...bodies, terminalEvidence: { ...bodies.terminalEvidence, verdictProtocol: version } }, true, 8, candidate))
        .toMatchObject({ complete: false, audit: { classification: 'semantic_invalid' } })
    }
    expect(JSON.parse(parsed.audit.rawResponse.content)).toBe(raw)
  })

  it.each(['wrong-kind', 'undefined-kind', 'null-kind', 'extra-key', 'missing-key', 'null-value', 'array-value', 'missing-result', 'missing-reason', 'missing-indexes', 'fake-conflict'] as const)('rejects an ambiguous or incomplete map: %s', scenario => {
    const value = checks() as Record<string, Record<string, unknown>>
    if (scenario === 'wrong-kind') value.action_direction.kind = 'state_progression'
    if (scenario === 'undefined-kind') value.action_direction.kind = undefined
    if (scenario === 'null-kind') value.action_direction.kind = null
    if (scenario === 'extra-key') value.extra = {}
    if (scenario === 'missing-key') delete value.state_progression
    if (scenario === 'null-value') value.action_direction = null as never
    if (scenario === 'array-value') value.action_direction = [] as never
    if (scenario === 'missing-result') delete value.action_direction.result
    if (scenario === 'missing-reason') delete value.action_direction.reason
    if (scenario === 'missing-indexes') delete value.action_direction.findingIndexes
    if (scenario === 'fake-conflict') { value.action_direction.result = 'conflict'; value.action_direction.findingIndexes = [0] }
    expect(validContinuitySemanticChecks(value, [], 2, true)).toBe(false)
  })

  it('rejects duplicate JSON keys rather than accepting a last-value override', () => {
    const raw = JSON.stringify(response()).replace('"semanticChecks":{', '"semanticChecks":{"action_direction":{"result":"conflict","reason":"conflicting duplicate","findingIndexes":[0]},')
    expect(inspectContinuityResponse(raw, body(), true, 8, candidate).complete).toBe(false)
  })

  it('shares the full strict response with reassessment and retains original decisions', () => {
    const bodies = body(), originalResponse = inspectContinuityResponse('{"findings":[]}', bodies, true, 8, candidate)
    const request = continuityReassessmentRequest('frozen system', 'frozen full input', originalResponse, bodies)
    expect(request.system).toContain('terminalProofVerdicts')
    expect(request.system).toContain('candidateFactId')
    expect(request.system).toContain('decisions')
    const raw = JSON.stringify({ decisions: [], ...response() })
    const result = applyContinuityReassessment(originalResponse, raw, bodies)
    expect(result.complete).toBe(true)
    expect(result.audit).toMatchObject({reassessment:{decisions:[]}})
    expect(() => applyContinuityReassessment(originalResponse, JSON.stringify({ decisions: [{ index: 0, action: 'retract', reason: 'invented', sourceEvidence: [{ source: 'current', quote: chapter.content }] }], ...response() }), bodies)).toThrow()
  })

  it('reassesses the existing body-only report without inventing terminal claims or losing decisions', async () => {
    const chapter = {id:'body-only',revision:1,orderIndex:1,content:'原文'}
    const bodies = {previous:null,current:chapter.content,terminalEvidence:terminalEvidenceContext(chapter,null,2,undefined,undefined,4)}
    const semanticChecks = ['action_direction','state_progression'].map(kind=>({kind,result:'not_applicable',reason:'已核对匿名原文无相关动作。',findingIndexes:[]}))
    const first = JSON.stringify({findings:[{signal:'object',severity:'error',evidence:'第1章却写“门已拆除”。',suggestion:'核对真实门状态。',sourceEvidence:[{source:'current',segmentId:'c0',quote:'原文'}]}],semanticChecks})
    const original = inspectContinuityResponse(first,bodies,true,8,undefined,{currentOrderIndex:1,previous:[]})
    expect(original.complete).toBe(false)
    const second = {decisions:[{index:0,action:'retract',reason:'旧句未在当前稿中出现。',sourceEvidence:[{source:'current',segmentId:'c0',quote:'原文'}]}],findings:[],semanticChecks}
    const dispatch = vi.fn().mockResolvedValue({content:JSON.stringify(second),complete:true}), claim = vi.fn().mockResolvedValue(true)
    const result = await runContinuityReassessment({original,bodies,system:'frozen',content:'frozen body-only input',billingKnown:true,providerComplete:true,slotUsed:false,
      signal:new AbortController().signal,assertCurrent:vi.fn(),claim,dispatch})
    expect(result).toMatchObject({complete:true,audit:{reassessment:{decisions:second.decisions}}})
    expect(result.audit).not.toHaveProperty('terminalCandidate')
    expect(dispatch).toHaveBeenCalledOnce(); expect(claim).toHaveBeenCalledOnce()
    const schema = JSON.parse(continuityReassessmentRequest('frozen','input',original,bodies).system.split('完整响应 JSON Schema（普通事实地址与语义 map 由服务端绑定，不补造任何独立判断）：')[1])
    expect(schema.required).toEqual(expect.arrayContaining(['decisions','findings','semanticChecks']))
    expect(schema.required).not.toContain('terminalVerdicts')
    expect(() => applyContinuityReassessment(original,JSON.stringify({...second,decisions:[]}),bodies)).toThrow()
  })

  it.each(['ordinary','proof','disposition','fake-conflict'] as const)('rejects unbound terminal data or false semantic clearance in a body-only report: %s', scenario => {
    const parts:Record<string,unknown> = {findings:[],semanticChecks:checks()}
    if (scenario==='ordinary') parts.terminalVerdicts = [{factId:'f'.repeat(64),verdict:'unknown',sourceEvidence:[]}]
    if (scenario==='proof') parts.terminalProofVerdicts = [{proofHash:'f'.repeat(64),currentState:'unchanged',reason:'Unbound proof.'}]
    if (scenario==='disposition') parts.terminalDispositions = [{id:'f'.repeat(64),outcome:'unknown',reason:'Unbound obligation.',sourceEvidence:[]}]
    if (scenario==='fake-conflict') parts.semanticChecks = {...checks(),action_direction:{result:'conflict',reason:'No error evidence.',findingIndexes:[0]}}
    expect(inspectContinuityResponse(JSON.stringify(parts),body(),true,8).complete).toBe(false)
  })

  it('binds fresh keyed semantics independently of whether the frozen task enabled fact coverage', () => {
    const bodies = {previous:null,current:chapter.content,terminalEvidence:terminalEvidenceContext(chapter,null,2,undefined,undefined,4)}
    expect(terminalResponseFields(false).semanticChecks.safeParse(checks()).success).toBe(true)
    expect(inspectContinuityResponse(JSON.stringify({findings:[],semanticChecks:checks()}),bodies,true,8).complete).toBe(true)
  })

  it('keeps the existing complete-report capacity in the fresh generated contract', () => {
    const prompt = freshContinuityResponseContract(false,false)
    const schema = JSON.parse(prompt.slice(prompt.indexOf('{')))
    expect(schema.properties.findings).not.toHaveProperty('maxItems')
    const findings = Array.from({length:31},(_,index)=>({signal:'object',severity:'warning',evidence:chapter.content,suggestion:`Review original item ${index}`,sourceEvidence:[{source:'current',segmentId:'c0',quote:chapter.content}]}))
    const parsed = inspectContinuityResponse(JSON.stringify({findings,semanticChecks:checks()}),body(),true,8)
    expect(parsed).toMatchObject({complete:true,findings:expect.any(Array)})
    expect(parsed.findings).toHaveLength(31)
  })

  it.each([candidate,terminalCandidateSchema.parse({exitState:{}})])('still requires a verdict array for every explicit frozen candidate', state => {
    expect(inspectContinuityResponse(JSON.stringify({findings:[],semanticChecks:checks()}),body(),true,8,state).complete).toBe(false)
  })

  it('uses the same strict semantic core for primary and second while preserving old contracts', () => {
    const shared = { action_direction: 'clear', state_progression: 'clear', reason: 'Checked body.' }
    const parts = { ...response(), semanticChecks: shared }
    expect(inspectContinuityResponse(JSON.stringify(parts), body(), true, 8, candidate).complete).toBe(false)
    const originalResponse = inspectContinuityResponse('{"findings":[]}', body(), true, 8, candidate)
    expect(() => applyContinuityReassessment(originalResponse, JSON.stringify({decisions:[],...parts}), body())).toThrow()
    expect(validContinuitySemanticChecks(shared, [], 2)).toBe(true)
  })

  it.each(['unknown', 'cross-field', 'duplicate-candidate', 'overlap-addresses', 'wrong-quote'] as const)('does not bind a foreign or ambiguous fact address: %s', scenario => {
    const c = structuredClone(candidate), parts = response(c)
    if (scenario === 'unknown') parts.terminalVerdicts[0].factId = 'f'.repeat(64)
    if (scenario === 'cross-field') parts.terminalVerdicts[0].factId = terminalFactId('knowledge', c.exitState.objects[0])
    if (scenario === 'duplicate-candidate') c.exitState.objects.push(c.exitState.objects[0])
    if (scenario === 'overlap-addresses') Object.assign(parts.terminalVerdicts[0], { path: 'exitState.objects.0' })
    if (scenario === 'wrong-quote') Object.assign(parts.terminalVerdicts[0].sourceEvidence[0], { quote: 'A fabricated quote.' })
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify(parts), true, evidence())).toBeNull()
  })

  it('requires a fresh whole-fact supported target to replace a retained obligation', () => {
    const c = terminalCandidateSchema.parse({ exitState: { objects: ['The crate is sealed.'] } }), context = evidence()
    const old = { id: terminalFactId('objects', 'The sealed crate.'), field: 'objects' as const, claim: 'The sealed crate.' }
    context.factCoverage!.obligations = [old]
    const parts = { ...response(c), terminalDispositions: [{ id: old.id, outcome: 'replaced', reason: 'The whole sealed-crate fact is represented.', candidateFactId: terminalFactId('objects', c.exitState.objects[0]), sourceEvidence: [] as Array<{segmentId: string}> }] }
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify(parts), true, context)?.supported).toBe(true)
    parts.terminalDispositions[0].candidateFactId = old.id
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify(parts), true, context)).toBeNull()
    parts.terminalDispositions[0].candidateFactId = terminalFactId('objects', c.exitState.objects[0])
    parts.terminalVerdicts[0].verdict = 'unknown'
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify(parts), true, context)).toBeNull()
    parts.terminalVerdicts[0].verdict = 'supported'
    context.factCoverage!.obligations[0].field = 'knowledge' as never
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify(parts), true, context)).toBeNull()
    parts.terminalDispositions[0].sourceEvidence = [{segmentId:'c0'}]
    expect(inspectTerminalReview(c, chapter.content, JSON.stringify(parts), true, context)?.supported).toBe(true)
    expect(terminalResponseFields().terminalDispositions.safeParse(parts.terminalDispositions).success).toBe(true)
  })
})

describe('explicit candidate delta and input recovery', () => {
  it('preserves unmentioned facts and gives reordered exact facts stable addresses', () => {
    const base = terminalCandidateSchema.parse({ exitState: { action: 'Inventory', location: 'Depot', storyTime: 'Dawn', objects: ['Crate', 'Seal'] }, lastUnfinishedAction: 'Open manifest' })
    const patch = terminalCandidatePatchSchema.parse({ baseCandidateHash: runtimeJson(base).hash, removeFactIds: [terminalFactId('objects', 'Crate'), terminalFactId('action', 'Inventory')], addFacts: [{ field: 'action', claim: 'Record' }, { field: 'knowledge', claim: 'Manifest missing' }] })
    const changed = applyTerminalCandidatePatch(base, patch)
    expect(changed).toEqual(terminalCandidateSchema.parse({ exitState: { action: 'Record', location: 'Depot', storyTime: 'Dawn', objects: ['Seal'], knowledge: ['Manifest missing'] }, lastUnfinishedAction: 'Open manifest' }))
    expect(terminalCandidateFacts(changed).find(fact => fact.claim === 'Seal')?.id).toBe(terminalCandidateFacts(base).find(fact => fact.claim === 'Seal')?.id)
    expect(base.exitState.objects).toEqual(['Crate', 'Seal'])
  })

  it.each(['old-base', 'unknown-id', 'duplicate-id', 'ambiguous-id', 'duplicate-add', 'remove-add-conflict', 'scalar-overwrite'] as const)('rejects a stale or ambiguous delta: %s', scenario => {
    const base = structuredClone(candidate), patch = terminalCandidatePatchSchema.parse({ baseCandidateHash: runtimeJson(candidate).hash })
    const id = terminalFactId('objects', candidate.exitState.objects[0])
    if (scenario === 'old-base') patch.baseCandidateHash = 'f'.repeat(64)
    if (scenario === 'unknown-id') patch.removeFactIds = ['f'.repeat(64)]
    if (scenario === 'duplicate-id') patch.removeFactIds = [id, id]
    if (scenario === 'ambiguous-id') { base.exitState.objects.push(base.exitState.objects[0]); patch.baseCandidateHash = runtimeJson(base).hash; patch.removeFactIds = [id] }
    if (scenario === 'duplicate-add') patch.addFacts = [{field:'objects',claim:'New'}, {field:'objects',claim:'New'}]
    if (scenario === 'remove-add-conflict') { patch.removeFactIds = [id]; patch.addFacts = [{field:'objects',claim:base.exitState.objects[0]}] }
    if (scenario === 'scalar-overwrite') { base.exitState.location = 'Depot'; patch.baseCandidateHash = runtimeJson(base).hash; patch.addFacts = [{field:'location',claim:'Hangar'}] }
    expect(() => applyTerminalCandidatePatch(base, patch)).toThrow(expect.objectContaining({code:'CONTINUITY_INPUT_STALE'}))
  })

  it.each(['location','objects','capacity'] as const)('keeps field limits and returns a classified error before dispatch: %s', scenario => {
    const base = terminalCandidateSchema.parse({exitState:scenario==='capacity'?{objects:Array.from({length:30},(_,i)=>String(i))}:{}})
    const patch = terminalCandidatePatchSchema.parse({baseCandidateHash:runtimeJson(base).hash,addFacts:[{field:scenario==='location'?'location':'objects',claim:scenario==='capacity'?'overflow':'x'.repeat(scenario==='location'?161:301)}]})
    expect(() => applyTerminalCandidatePatch(base, patch)).toThrow(expect.objectContaining({code:'TERMINAL_STATE_REVIEW_REQUIRED'}))
  })

  it('recovers the same owned canonical delta after application but rejects a new call or concurrent candidate change', async () => {
    const ctx = { userId:'u',novelId:'n',runId:'r',callId:'call',sessionId:'s',signal:new AbortController().signal } as ToolContext
    const scope = {id:'compiler',validation:{terminalCandidate:candidate},chapter:{...chapter}}, patch = terminalCandidatePatchSchema.parse({baseCandidateHash:runtimeJson(candidate).hash,addFacts:[{field:'knowledge',claim:'The manifest is missing.'}]})
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({taskId:'original'} as never)
    const rows = new Map<string, unknown>()
    const create = vi.fn(async ({data}:{data:{id:string;runId:string;metadata:unknown}})=>{
      // AgentArtifact.id is VARCHAR(64), including in the initial migration.
      expect(data.id.length).toBeLessThanOrEqual(64)
      rows.set(data.id,data);return data
    })
    const tx = {agentArtifact:{findUnique:vi.fn(async ({where}:{where:{id:string}})=>rows.get(where.id)??null),create}} as unknown as Prisma.TransactionClient
    try {
      expect(await readFrozenLegacyTerminalPatch(tx,ctx,scope,null,[],2,patch)).toBeNull()
      expect(create).not.toHaveBeenCalled()
      const frozen = await freezeLegacyTerminalPatch(tx,ctx,scope,null,[],2,patch)
      expect(create).toHaveBeenCalledTimes(1)
      const applied = {...scope,validation:{terminalCandidate:frozen.candidate}}
      expect(await freezeLegacyTerminalPatch(tx,ctx,applied,null,[],2,patch)).toEqual({candidate:frozen.candidate,expectedBaseHash:runtimeJson(frozen.candidate).hash})
      expect(create).toHaveBeenCalledTimes(1)
      await expect(freezeLegacyTerminalPatch(tx,{...ctx,callId:'new-call'},applied,null,[],2,patch)).rejects.toMatchObject({code:'CONTINUITY_INPUT_STALE'})
      const concurrent = {...scope,validation:{terminalCandidate:terminalCandidateSchema.parse({exitState:{emotion:['Uncertain']}})}}
      await expect(freezeLegacyTerminalPatch(tx,ctx,concurrent,null,[],2,patch)).rejects.toMatchObject({code:'CONTINUITY_INPUT_STALE'})
      await expect(freezeLegacyTerminalPatch(tx,{...ctx,userId:'other'},applied,null,[],2,patch)).rejects.toMatchObject({code:'CONTINUITY_INPUT_STALE'})
      expect(create).toHaveBeenCalledTimes(1)
    } finally { vi.restoreAllMocks() }
  })

  it('freezes a current patch with no removed proposals as valid JSON, without changing the old snapshot contract', async () => {
    const ctx = { userId: 'u', novelId: 'n', runId: 'r', callId: 'new-current-call', signal: new AbortController().signal }
    const scope = { id: 'compiler', validation: { terminalCandidate: candidate }, chapter }
    const patch = terminalCandidatePatchSchema.parse({ baseCandidateHash: runtimeJson(candidate).hash })
    vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'original' } as never)
    const create = vi.fn(async ({ data }: { data: { metadata: unknown } }) => data)
    const tx = { agentArtifact: { findUnique: vi.fn().mockResolvedValue(null), create } } as unknown as Prisma.TransactionClient
    try {
      expect(await freezeLegacyTerminalPatch(tx, ctx, scope, null, [], 2, patch, [], () => undefined)).toMatchObject({ proposalVersion: 2, candidate })
      expect(create).toHaveBeenCalledOnce()
      expect(create.mock.calls[0][0].data.metadata).toMatchObject({ version: 2, candidate })
      expect(create.mock.calls[0][0].data.metadata).not.toHaveProperty('proposalReview')
    } finally { vi.restoreAllMocks() }
  })
})
