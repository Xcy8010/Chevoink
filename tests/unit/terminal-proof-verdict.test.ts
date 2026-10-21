import { describe, expect, it } from 'vitest'
import { inspectTerminalReview, resolveTerminalCandidate, reviewTerminalSelection, terminalCandidateSchema, terminalReviewInput, type TerminalReviewDiagnostic } from '../../api/lib/agent/terminal-state-review.js'
import { terminalProofCatalog } from '../../api/lib/agent/terminal-proof-verdict.js'
import { advanceTerminalCoverage, terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { TerminalCarriedFact, TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment, continuityReassessmentRequest } from '../../api/lib/agent/assessment-response-lifecycle.js'

const claim = 'The pump repair still awaits a replacement seal.'
const fact = (text: string) => ({ id: runtimeJson({field:'openLoops',claim:text}).hash, field:'openLoops' as const, claim:text })
const proof: TerminalCarriedFact = { proofHash:'a'.repeat(64), segmentId:'t4', field:'openLoops', claim, depth:1,
  anchors:[{chapterId:'previous',revision:2,contentHash:'b'.repeat(64),start:0,end:30,quote:'The pump awaits a replacement.'}],
  nodes:[{compilationId:'previous-compiler',chapterId:'previous',revision:2,orderIndex:1,bodyHash:'b'.repeat(64),candidateHash:'c'.repeat(64),validationHash:'d'.repeat(64),stateHash:'e'.repeat(64),path:'exitState.openLoops.0',previousChapterId:null}] }
const candidate = terminalCandidateSchema.parse({exitState:{openLoops:[claim]}})
const content = 'The officer inventories a crate.'
const context = (body=content): TerminalEvidenceContext => ({protocol:2,quoteAddressProtocol:1,verdictProtocol:3,
  current:{id:'current',revision:3,orderIndex:2,contentHash:runtimeJson({content:body}).hash},
  previous:{id:'previous',revision:2,orderIndex:1,contentHash:'b'.repeat(64),start:0,end:30,joinedStart:0,joinedEnd:30,segments:[],carried:[proof]},
  factCoverage:{version:2,taskId:'task',chapterId:'current',obligations:[]}})
const raw = (state='unchanged', more: Record<string,unknown>={}) => JSON.stringify({findings:[],terminalVerdicts:[],terminalDispositions:[],
  terminalProofVerdicts:[{proofHash:proof.proofHash,currentState:state,reason:'Independent whole-body persistence judgment.'}],...more})

describe('stable inherited proof judgments',()=>{
  it('binds only an exact explicitly included field/whole claim, without adding any omitted fact',()=>{
    expect(terminalProofCatalog(candidate,context())).toMatchObject([{fact:proof,paths:['exitState.openLoops.0']}])
    expect(terminalProofCatalog(terminalCandidateSchema.parse({exitState:{}}),context())).toEqual([])
    expect(terminalProofCatalog(terminalCandidateSchema.parse({exitState:{knowledge:[claim],openLoops:['The pump has been repaired.']}}),context())).toEqual([])
    expect(terminalProofCatalog(candidate,{...context(),previous:{...context().previous!,carried:[proof,{...proof,proofHash:'f'.repeat(64)}]}})).toEqual([])
    expect(terminalProofCatalog(candidate,{...context(),previous:{...context().previous!,carried:[{...proof,depth:16}]}})).toEqual([])
  })
  it('supports only a new explicit independent unchanged judgment and derives the existing exact proof evidence',()=>{
    const result=inspectTerminalReview(candidate,content,raw(),true,context())
    expect(result).toMatchObject({supported:true,candidate,proofChecks:[{proofHash:proof.proofHash,currentState:'unchanged'}],
      verdicts:[{path:'exitState.openLoops.0',verdict:'supported',basis:'inherited',sourceEvidence:[{segmentId:'t4',quote:proof.anchors[0].quote}],inheritance:{priorEndState:'established',currentState:'unchanged'}}]})
    expect(terminalReviewInput(candidate,context())).toContain('terminalProofVerdicts')
  })
  it('preserves ordinary previous-text inheritance conditions alongside selected proofs',()=>{
    const previousBody='The officer holds the key.',ordinary=terminalCandidateSchema.parse({exitState:{objects:[previousBody]}})
    const evidence=context()
    evidence.previous={...evidence.previous!,joinedStart:0,joinedEnd:previousBody.length,start:0,end:previousBody.length,carried:[],
      segments:[{segmentId:'p0',start:0,end:previousBody.length,quote:previousBody,hash:runtimeJson({text:previousBody}).hash}]}
    const item={path:'exitState.objects.0',verdict:'supported',sourceEvidence:[{segmentId:'p0',quote:previousBody}],inheritance:{priorEndState:'established',currentState:'unchanged'}}
    const response=(value:unknown)=>JSON.stringify({findings:[],terminalVerdicts:[value],terminalProofVerdicts:[],terminalDispositions:[]})
    expect(inspectTerminalReview(ordinary,content,response(item),true,evidence)?.supported).toBe(true)
    expect(inspectTerminalReview(ordinary,content,response({...item,inheritance:undefined}),true,evidence)).toBeNull()
    expect(inspectTerminalReview(ordinary,content,response({...item,sourceEvidence:[{segmentId:'c0',quote:content}]}),true,evidence)).toBeNull()
    const prompt=terminalReviewInput(ordinary,evidence)
    expect(prompt).toContain('pN 的 supported 必须给 inheritance={priorEndState:"established",currentState:"unchanged"}')
    expect(prompt).toContain('cN 的 supported 不得带 inheritance')
    expect(prompt).toContain('lastUnfinishedAction 不能凭未提及延续')
    const selected={...item,sourceEvidence:[{segmentId:'p0'}]}
    expect(inspectTerminalReview(ordinary,content,response(selected),true,evidence)).toMatchObject({supported:true,
      verdicts:[{sourceEvidence:[{segmentId:'p0',quote:previousBody}]}],spanSelections:[{sourceEvidence:[{segmentId:'p0'}]}]})
    for(const rejected of [
      {...selected,inheritance:{priorEndState:'uncertain',currentState:'unchanged'}},
      {...selected,inheritance:{priorEndState:'established',currentState:'changed'}},
      {...selected,sourceEvidence:[{segmentId:'p99'}]},
    ])expect(inspectTerminalReview(ordinary,content,response(rejected),true,evidence)).toBeNull()
    const transient=terminalCandidateSchema.parse({exitState:{location:previousBody}})
    expect(inspectTerminalReview(transient,content,response({...selected,path:'exitState.location'}),true,evidence)).toBeNull()
  })
  it.each(['selected-span','bad-quote','unknown-id','old-contract','mixed-source','unselected-t'] as const)('binds server text only for an admitted fresh span selection: %s',scenario=>{
    const body='The clerk said, "The fee is forty-five. Signing does not allow a refund."'
    const state=terminalCandidateSchema.parse({exitState:{knowledge:['The fee is forty-five.']}}),evidence=context(body)
    const refs:Array<{segmentId:string;quote?:string}>=[{segmentId:'c0'}]
    if(scenario==='bad-quote')refs[0].quote='"The fee is forty-five."'
    if(scenario==='unknown-id')refs[0].segmentId='c99'
    if(scenario==='old-contract')evidence.verdictProtocol=2
    if(scenario==='mixed-source'){
      const quote='Original previous text.'
      evidence.previous!.segments=[{segmentId:'p0',start:0,end:quote.length,quote,hash:runtimeJson({text:quote}).hash}]
      refs.push({segmentId:'p0',quote})
    }
    if(scenario==='unselected-t')refs[0].segmentId='t4'
    const response=JSON.stringify({findings:[],terminalVerdicts:[{path:'exitState.knowledge.0',verdict:'supported',sourceEvidence:refs}],terminalProofVerdicts:[],terminalDispositions:[]})
    const reviewed=inspectTerminalReview(state,body,response,true,evidence)
    if(scenario==='selected-span')expect(reviewed).toMatchObject({supported:true,spanSelections:[{path:'exitState.knowledge.0',sourceEvidence:[{segmentId:'c0'}]}],
      verdicts:[{sourceEvidence:[{segmentId:'c0',quote:body}]}]})
    else expect(reviewed).toBeNull()
    expect(inspectTerminalReview(state,body,response.replace('"supported"','"unknown"'),true,evidence)?.supported??false).toBe(false)
  })
  it('keeps both frozen groups and a fresh explicit judgment in the existing single full reassessment',()=>{
    const semanticChecks=['action_direction','state_progression'].map(kind=>({kind,result:'not_applicable',reason:'No applicable synthetic action conflict.',findingIndexes:[]}))
    const selected=terminalCandidateSchema.parse({exitState:{openLoops:[claim],objects:[content]}})
    const bodies={previous:null,current:content,terminalEvidence:context()}
    const first=inspectContinuityResponse(JSON.stringify({findings:[],semanticChecks,terminalVerdicts:[],terminalDispositions:[]}),bodies,true,8,selected)
    expect(first.complete).toBe(false)
    expect(continuityReassessmentRequest('system',terminalReviewInput(selected,context()),first,bodies).content).toContain('普通 terminalVerdicts 和历史 terminalProofVerdicts')
    const response=JSON.stringify({...JSON.parse(raw()),decisions:[],semanticChecks,terminalVerdicts:[{path:'exitState.objects.0',verdict:'supported',sourceEvidence:[{segmentId:'c0'}]}]})
    const reviewed=applyContinuityReassessment(first,response,bodies)
    expect(reviewed.complete).toBe(true)
    expect(inspectTerminalReview(selected,content,response,true,context())?.supported).toBe(true)
    expect(JSON.parse(reviewed.audit.rawResponse.content)).toBe(response)
  })
  it.each(['changed','uncertain'])('keeps %s unsupported without inferring ended or negated',state=>{
    const result=inspectTerminalReview(candidate,content,raw(state),true,context())
    expect(result).toMatchObject({supported:false,verdicts:[{verdict:'unknown'}],proofChecks:[{currentState:state}]})
  })
  it.each(['missing','duplicate','unknown','extra-quote','overlapping-path'] as const)('rejects %s proof coverage without selecting a favorable verdict',scenario=>{
    const item={proofHash:proof.proofHash,currentState:'unchanged',reason:'Whole-body check.'}
    const value=JSON.parse(raw())
    if(scenario==='missing')delete value.terminalProofVerdicts
    if(scenario==='duplicate')value.terminalProofVerdicts=[item,item]
    if(scenario==='unknown')value.terminalProofVerdicts=[{...item,proofHash:'f'.repeat(64)}]
    if(scenario==='extra-quote')value.terminalProofVerdicts=[{...item,quote:'Injected replacement'}]
    if(scenario==='overlapping-path')value.terminalVerdicts=[{path:'exitState.openLoops.0',verdict:'unknown',sourceEvidence:[]}]
    expect(inspectTerminalReview(candidate,content,JSON.stringify(value),true,context())).toBeNull()
  })
  it('does not reinterpret old v1/v2 unknown responses or accept new proof fields as old support',()=>{
    const old=JSON.stringify({findings:[],terminalVerdicts:[{path:'exitState.openLoops.0',verdict:'unknown',basis:'inherited',sourceEvidence:[{segmentId:'t4',quote:proof.anchors[0].quote}]}]})
    for(const verdictProtocol of [undefined,2] as const){
      const frozen=context()
      delete frozen.verdictProtocol
      if(verdictProtocol!==undefined)frozen.verdictProtocol=verdictProtocol
      const diagnostics: TerminalReviewDiagnostic[]=[]
      expect(inspectTerminalReview(candidate,content,old,true,frozen,diagnostics)?.supported,JSON.stringify(diagnostics)).toBe(false)
      expect(inspectTerminalReview(candidate,content,raw(),true,frozen)).toBeNull()
    }
  })
  it('does not make transient t numbering or candidate input mutations a proof selection',()=>{
    const saved=terminalCandidateSchema.parse({exitState:{objects:['The crate is sealed.']}}),before=structuredClone(saved)
    const selected=reviewTerminalSelection(undefined,saved,[proof.proofHash])!
    const resolved=resolveTerminalCandidate(selected,[proof],2)
    expect(resolved).toEqual({ok:true,candidate:terminalCandidateSchema.parse({exitState:{objects:saved.exitState.objects,openLoops:[claim]}})})
    expect(saved).toEqual(before)
    expect(reviewTerminalSelection(undefined,saved)).toBeUndefined()
    const renumbered={...context(),previous:{...context().previous!,carried:[{...proof,segmentId:'t19'}]}}
    expect(inspectTerminalReview(candidate,content,raw(),true,renumbered)).toMatchObject({supported:true,verdicts:[{sourceEvidence:[{segmentId:'t19'}]}]})
  })
  it('requires independent per-alias replacement, keeps unknown obligations, and does not grow the exact fact identity',()=>{
    const spec={id:'task',scope:{terminalCoverageProtocol:1}},chapter={id:'current',content},aliases=[fact('The pump repair.'),fact('The seal is still outstanding.')]
    const prepared={terminalFactCoverage:{version:1,taskId:'task',chapterId:'current',facts:[...aliases,fact(claim)],
      lastReview:{bodyHash:'0'.repeat(64),candidateHash:'1'.repeat(64),input:{version:2,taskId:'task',chapterId:'current',obligations:[]}}}}
    const evidence={...context(),factCoverage:terminalCoverageInput(spec,prepared,chapter,candidate,2)!}
    const dispositions=aliases.map(({id})=>({id,outcome:'replaced',reason:'Independent whole-fact equivalence to the same still-pending repair.',candidatePath:'exitState.openLoops.0',sourceEvidence:[]}))
    const reviewed=inspectTerminalReview(candidate,content,raw('unchanged',{terminalDispositions:dispositions}),true,evidence)!
    expect(reviewed.supported).toBe(true)
    expect(advanceTerminalCoverage(spec,prepared,chapter,reviewed)?.facts).toEqual([fact(claim)])
    const uncertain=inspectTerminalReview(candidate,content,raw('unchanged',{terminalDispositions:[dispositions[0],{id:aliases[1].id,outcome:'unknown',reason:'Cannot establish equivalence.',sourceEvidence:[]}]}),true,evidence)!
    expect(uncertain.supported).toBe(false)
    expect(advanceTerminalCoverage(spec,prepared,chapter,uncertain)?.facts).toEqual(expect.arrayContaining([aliases[1],fact(claim)]))
    expect(inspectTerminalReview(candidate,content,raw('unchanged',{terminalDispositions:[dispositions[0]]}),true,evidence)).toBeNull()
  })
  it('allows a truly resolved omitted fact to end without adding it back into the candidate',()=>{
    const body='The pump repair is complete.',empty=terminalCandidateSchema.parse({exitState:{}}),evidence=context(body)
    evidence.factCoverage!.obligations=[fact(claim)]
    const response=JSON.stringify({findings:[],terminalVerdicts:[],terminalProofVerdicts:[],terminalDispositions:[{id:fact(claim).id,outcome:'ended',reason:'The complete repair resolves the original obligation.',sourceEvidence:[{segmentId:'c0',quote:body}]}]})
    expect(inspectTerminalReview(empty,body,response,true,evidence)).toMatchObject({supported:true,candidate:empty})
  })
})
