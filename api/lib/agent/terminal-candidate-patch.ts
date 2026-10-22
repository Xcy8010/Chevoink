import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { terminalCandidateSchema, readTerminalCandidate, resolveTerminalCandidate, type TerminalCandidate } from './terminal-state-review.js'
import { terminalCandidateFacts, terminalFactId } from './terminal-fact-identity.js'
import type { TerminalCarriedFact } from './terminal-evidence-context.js'
import type { ToolContext } from './tools/types.js'
import { readOriginalTaskRequest } from './original-request.js'
import { terminalProposalTaskId, type TerminalProposalPreparation } from './terminal-proposal-context.js'
import { terminalProposalChangesSchema, terminalProposalStateSchema, readTerminalProposalState } from './terminal-proposal-review.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const field = z.enum(['action','location','storyTime','emotion','knowledge','body','objects','relationships','openLoops','lastUnfinishedAction'])
export const terminalCandidatePatchSchema = z.object({ baseCandidateHash: hash,
  removeFactIds: z.array(hash).max(200).default([]),
  addFacts: z.array(z.object({ field, claim: z.string().trim().min(1).max(1000) }).strict()).max(200).default([]),
}).strict()
export type TerminalCandidatePatch = z.infer<typeof terminalCandidatePatchSchema>
const stale = () => new DataAccessError(409,'CONTINUITY_INPUT_STALE','章末候选已变化或事实地址不唯一；请读取当前章节桥后只更新需要处理的事实，未派发旧补丁。')

/** Keep failed claims as unresolved processing data, not established facts.
 * A fresh proposal must express its replacement instead of silently removing
 * the difficult field. Independent review still decides every replacement. */
export function terminalCandidateReplacementIssue(validation: unknown, candidate: TerminalCandidate, content: string): string | null {
  const saved = validation as { independentCheck?: unknown; continuityCriticResponse?: { classification?: unknown; terminalContentHash?: unknown; terminalCandidate?: unknown } } | null
  const base = readTerminalCandidate(validation), audit = saved?.continuityCriticResponse
  if (!base || saved?.independentCheck !== 'unavailable' || audit?.classification !== 'terminal_invalid'
    || audit.terminalContentHash !== runtimeJson({ content }).hash || runtimeJson(audit.terminalCandidate).hash !== runtimeJson(base).hash) return null
  const before = terminalCandidateFacts(base), after = terminalCandidateFacts(candidate)
  const additions = after.filter(fact => !before.some(prior => prior.id === fact.id))
  const removed = before.filter(fact => !after.some(next => next.id === fact.id))
  return removed.some(fact => additions.filter(next => next.field === fact.field).length
    < removed.filter(prior => prior.field === fact.field).length)
    ? '失败候选不能只删除问题事实；请明确同字段的事实替换或拆分，保留未解决事项及其状态。原候选和失败记录保留，未派发新检查；替换后仍须独立核验。' : null
}

/** This legacy delta producer freezes before reserving any model request.
 * A prior exact-call snapshot/reservation prevents a local refusal from being
 * mistaken for proof about an earlier, possibly unknown provider attempt. */
export async function hasLegacyTerminalCallEvidence(tx: Prisma.TransactionClient,
  ctx: Pick<ToolContext, 'runId' | 'callId'>) {
  return !!await tx.agentArtifact.findFirst({ where: { runId: ctx.runId, artifactType: 'continuityReview', OR: [
    { metadata: { path: ['callId'], equals: ctx.callId } },
    { metadata: { path: ['identity', 'callId'], equals: ctx.callId } },
  ] }, select: { id: true } })
}

/** Explicit delta on this saved candidate only. Omission is not deletion;
 * deleting a candidate fact never deletes its coverage obligation. */
export function applyTerminalCandidatePatch(base: TerminalCandidate, patch: TerminalCandidatePatch) {
  if (runtimeJson(base).hash !== patch.baseCandidateHash || new Set(patch.removeFactIds).size !== patch.removeFactIds.length
    || new Set(patch.addFacts.map(fact=>terminalFactId(fact.field,fact.claim))).size !== patch.addFacts.length) throw stale()
  const result=structuredClone(base),facts=terminalCandidateFacts(base)
  for(const id of patch.removeFactIds){
    const matches=facts.filter(fact=>fact.id===id)
    if(matches.length!==1)throw stale()
    const fact=matches[0],name=field.parse(fact.field)
    if(name==='lastUnfinishedAction')result.lastUnfinishedAction=''
    else if(name==='action'||name==='location'||name==='storyTime')delete result.exitState[name]
    else result.exitState[name]=result.exitState[name].filter(claim=>claim!==fact.claim)
  }
  for(const fact of patch.addFacts){
    if(patch.removeFactIds.includes(terminalFactId(fact.field,fact.claim)))throw stale()
    const name=fact.field
    if(name==='lastUnfinishedAction'){
      if(result.lastUnfinishedAction&&result.lastUnfinishedAction!==fact.claim)throw stale()
      result.lastUnfinishedAction=fact.claim
    }else if(name==='action'||name==='location'||name==='storyTime'){
      if(result.exitState[name]&&result.exitState[name]!==fact.claim)throw stale()
      result.exitState[name]=fact.claim
    }else if(!result.exitState[name].includes(fact.claim))result.exitState[name].push(fact.claim)
  }
  const parsed = terminalCandidateSchema.safeParse(result)
  if (!parsed.success) throw new DataAccessError(409, 'TERMINAL_STATE_REVIEW_REQUIRED', '增量候选超出原字段长度或容量；原候选保留，未派发检查。')
  return parsed.data
}

const identitySchema=z.object({userId:z.string(),novelId:z.string(),taskId:z.string(),runId:z.string(),callId:z.string(),compilationId:z.string(),
  chapterId:z.string(),revision:z.number().int(),bodyHash:hash,sourceHash:hash}).strict()
const snapshotSchema=z.object({version:z.literal(1),kind:z.literal('terminalCandidatePatch'),identity:identitySchema,
  request:z.object({patch:terminalCandidatePatchSchema,inheritedProofs:z.array(hash)}).strict(),base:terminalCandidateSchema,candidate:terminalCandidateSchema}).strict()
const proposalPreparationSchema = z.object({ state: terminalProposalStateSchema, changes: terminalProposalChangesSchema.optional() }).strict()
const currentSnapshotSchema = snapshotSchema.extend({ version: z.literal(2), proposalReview: proposalPreparationSchema.optional() })
const savedSnapshotSchema = z.discriminatedUnion('version', [snapshotSchema, currentSnapshotSchema])
function validateProposalSnapshot(snapshot: z.infer<typeof currentSnapshotSchema>, taskId: string) {
  const prepared = snapshot.proposalReview
  if (!prepared) return
  const state = readTerminalProposalState({ terminalProposalReview: prepared.state }, { taskId, chapterId: snapshot.identity.chapterId })!
  if (prepared.changes ? prepared.changes.taskId !== taskId || prepared.changes.chapterId !== snapshot.identity.chapterId
    || prepared.changes.bodyHash !== snapshot.identity.bodyHash || prepared.changes.candidateHash !== runtimeJson(snapshot.candidate).hash
    || runtimeJson(prepared.changes).hash !== runtimeJson(state.lastInput.input).hash
    || runtimeJson(state.pending).hash !== runtimeJson(prepared.changes.proposals).hash : state.pending.length > 0) throw stale()
}

/** Same owned call recovers its canonical delta result before testing an old
 * base hash. A new call still needs the current base. No provider/fee authority
 * is created by this input snapshot; the existing review lifecycle owns that. */
async function legacyTerminalPatch(tx: Prisma.TransactionClient,ctx: Pick<ToolContext,'userId'|'novelId'|'runId'|'callId'>,
  compilation:{id:string;validation:unknown;chapter:{id:string;revision:number;content:string}},
  source:unknown,carried:TerminalCarriedFact[]|undefined,protocol:1|2|undefined,patch:TerminalCandidatePatch,inheritedProofs:string[]=[],readOnly=false,
  prepareProposals?: (candidate: TerminalCandidate) => TerminalProposalPreparation | undefined){
  const original=await readOriginalTaskRequest(tx,ctx)
  const identity={userId:ctx.userId,novelId:ctx.novelId,taskId:original.taskId,runId:ctx.runId,callId:ctx.callId,
    compilationId:compilation.id,chapterId:compilation.chapter.id,revision:compilation.chapter.revision,
    bodyHash:runtimeJson({content:compilation.chapter.content}).hash,sourceHash:runtimeJson({source:source??null}).hash}
  // Keep the full domain-separated hash within AgentArtifact.id VARCHAR(64).
  const request={patch,inheritedProofs},id=runtimeJson({kind:'terminalCandidatePatch',runId:ctx.runId,callId:ctx.callId,compilationId:compilation.id}).hash
  const saved=await tx.agentArtifact.findUnique({where:{id},select:{runId:true,metadata:true}})
  const current=readTerminalCandidate(compilation.validation)
  if(!current)throw stale()
  if(saved){
    const snapshot=savedSnapshotSchema.safeParse(saved.metadata)
    if(!snapshot.success||saved.runId!==ctx.runId||runtimeJson(snapshot.data.identity).hash!==runtimeJson(identity).hash
      ||runtimeJson(snapshot.data.request).hash!==runtimeJson(request).hash)throw stale()
    if(snapshot.data.version === 2) validateProposalSnapshot(snapshot.data, terminalProposalTaskId(original.spec, original.taskId))
    const rebuilt=resolveTerminalCandidate({...applyTerminalCandidatePatch(snapshot.data.base,patch),inheritedProofs},carried,protocol)
    if(!rebuilt.ok||runtimeJson(rebuilt.candidate).hash!==runtimeJson(snapshot.data.candidate).hash
      ||![patch.baseCandidateHash,runtimeJson(rebuilt.candidate).hash].includes(runtimeJson(current).hash))throw stale()
    return {candidate:rebuilt.candidate,expectedBaseHash:runtimeJson(current).hash,
      ...(snapshot.data.version === 2 ? { proposalVersion: 2 as const, proposalReview: snapshot.data.proposalReview } : {})}
  }
  if(readOnly)return null
  const selected=resolveTerminalCandidate({...applyTerminalCandidatePatch(current,patch),inheritedProofs},carried,protocol)
  if(!selected.ok)throw stale()
  const issue=terminalCandidateReplacementIssue(compilation.validation,selected.candidate,compilation.chapter.content)
  const proposalReview = prepareProposals?.(selected.candidate)
  if(issue && !proposalReview?.changes)throw new DataAccessError(409,'TERMINAL_STATE_REVIEW_REQUIRED',issue)
  const snapshot=prepareProposals
    ? currentSnapshotSchema.parse({version:2,kind:'terminalCandidatePatch',identity,request,base:current,candidate:selected.candidate,
      ...(proposalReview ? { proposalReview } : {})})
    : snapshotSchema.parse({version:1,kind:'terminalCandidatePatch',identity,request,base:current,candidate:selected.candidate})
  if (snapshot.version === 2) validateProposalSnapshot(snapshot, terminalProposalTaskId(original.spec, original.taskId))
  await tx.agentArtifact.create({data:{id,runId:ctx.runId,artifactType:'continuityReview',title:'章末候选增量输入快照',content:'',metadata:runtimeJson(snapshot).value}})
  return {candidate:selected.candidate,expectedBaseHash:patch.baseCandidateHash,
    ...(snapshot.version === 2 ? { proposalVersion: 2 as const, proposalReview: snapshot.proposalReview } : {})}
}

export const readFrozenLegacyTerminalPatch = (tx: Prisma.TransactionClient,ctx: Pick<ToolContext,'userId'|'novelId'|'runId'|'callId'>,
  ...input: [compilation:{id:string;validation:unknown;chapter:{id:string;revision:number;content:string}},source:unknown,
    carried:TerminalCarriedFact[]|undefined,protocol:1|2|undefined,patch:TerminalCandidatePatch,inheritedProofs?:string[]]) =>
  legacyTerminalPatch(tx,ctx,input[0],input[1],input[2],input[3],input[4],input[5]??[],true)

export async function freezeLegacyTerminalPatch(tx: Prisma.TransactionClient,ctx: Pick<ToolContext,'userId'|'novelId'|'runId'|'callId'|'signal'>,
  ...input: [compilation:{id:string;validation:unknown;chapter:{id:string;revision:number;content:string}},source:unknown,
    carried:TerminalCarriedFact[]|undefined,protocol:1|2|undefined,patch:TerminalCandidatePatch,inheritedProofs?:string[],
    prepareProposals?: (candidate: TerminalCandidate) => TerminalProposalPreparation | undefined]) {
  ctx.signal.throwIfAborted()
  return (await legacyTerminalPatch(tx,ctx,input[0],input[1],input[2],input[3],input[4],input[5] ?? [],false,input[6]))!
}
