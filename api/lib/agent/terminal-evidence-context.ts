import { z } from 'zod'
import { continuitySourceSegments } from './continuity-review-context.js'
import { runtimeJson } from './runtime-common.js'
import type { readCompilerContinuitySource } from './compiler-continuity-source.js'
import { terminalCoverageInputSchema, type TerminalCoverageInput } from './terminal-fact-coverage.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const terminalFactNodeSchema = z.object({ compilationId: z.string(), chapterId: z.string(), revision: z.number().int(),
  orderIndex: z.number().int(), bodyHash: hash, candidateHash: hash, validationHash: hash, stateHash: hash,
  path: z.string(), previousChapterId: z.string().nullable(),
}).strict()
export const terminalCarriedFactSchema = z.object({ segmentId: z.string().regex(/^t[0-9]+$/), field: z.string(), claim: z.string(),
  proofHash: hash, depth: z.number().int().min(1).max(16),
  nodes: z.array(terminalFactNodeSchema).min(1).max(16),
  anchors: z.array(z.object({ chapterId: z.string(), revision: z.number().int(), contentHash: hash,
    start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().min(2).max(300) }).strict()).min(1).max(8),
}).strict()
export type TerminalCarriedFact = z.infer<typeof terminalCarriedFactSchema>
export const terminalEvidenceContextSchema = z.object({
  protocol: z.union([z.literal(1), z.literal(2)]),
  quoteAddressProtocol: z.literal(1).optional(),
  factCoverage: terminalCoverageInputSchema.optional(),
  current: z.object({ id: z.string(), revision: z.number().int(), orderIndex: z.number().int(), contentHash: hash }).strict(),
  previous: z.object({ id: z.string(), revision: z.number().int(), orderIndex: z.number().int(), contentHash: hash,
    start: z.number().int(), end: z.number().int(), joinedStart: z.number().int(), joinedEnd: z.number().int(),
    segments: z.array(z.object({ segmentId: z.string().regex(/^p[0-9]+$/), start: z.number().int(), end: z.number().int(), quote: z.string(), hash }).strict()),
    carried: z.array(terminalCarriedFactSchema).max(200).optional(),
  }).strict().nullable(),
}).strict()
export type TerminalEvidenceContext = z.infer<typeof terminalEvidenceContextSchema>

/** Only a fresh HTTP admission opts in. Saved contracts are never upgraded. */
export function hasTerminalEvidenceProtocol(spec: unknown): boolean {
  const value = spec as { scope?: { terminalEvidenceProtocol?: unknown } } | null
  return value?.scope?.terminalEvidenceProtocol === 1 || value?.scope?.terminalEvidenceProtocol === 2
}
export function terminalEvidenceVersion(spec: unknown): 1 | 2 | undefined {
  const value = spec as { scope?: { terminalEvidenceProtocol?: unknown } } | null
  return value?.scope?.terminalEvidenceProtocol === 2 ? 2 : value?.scope?.terminalEvidenceProtocol === 1 ? 1 : undefined
}
export function terminalQuoteAddressVersion(spec: unknown): 1 | undefined {
  const value = spec as { scope?: { terminalQuoteAddressProtocol?: unknown } } | null
  return value?.scope?.terminalQuoteAddressProtocol === 1 ? 1 : undefined
}

/** Derive proof addresses from the actual active predecessor, not a bridge
 * summary. A 300-character span crossing chapter boundaries cannot inherit. */
export function terminalEvidenceContext(chapter: { id: string; revision: number; orderIndex: number; content: string },
  source: Awaited<ReturnType<typeof readCompilerContinuitySource>>, version: 1 | 2 = source && 'terminalInheritance' in source ? 2 : 1,
  quoteAddressProtocol?: 1, factCoverage?: TerminalCoverageInput): TerminalEvidenceContext {
  const previous = source && 'preceding' in source ? source.preceding.at(-1) : undefined
  return { protocol: version, ...(quoteAddressProtocol === 1 ? { quoteAddressProtocol } : {}), ...(factCoverage ? { factCoverage } : {}), current: { id: chapter.id, revision: chapter.revision, orderIndex: chapter.orderIndex,
    contentHash: runtimeJson({ content: chapter.content }).hash }, previous: previous ? {
    id: previous.id, revision: previous.revision, orderIndex: previous.orderIndex, contentHash: previous.contentHash,
    start: previous.start, end: previous.end, joinedStart: previous.joinedStart, joinedEnd: previous.joinedEnd,
    ...('terminalInheritance' in source! ? { carried: source.terminalInheritance } : {}),
    segments: continuitySourceSegments({ previous: source!.content, current: '' }).filter(part => {
      const start = Number(part.segmentId.slice(1)) * 300
      return start >= previous.joinedStart && start + part.quote.length <= previous.joinedEnd
    }).map(part => { const start = Number(part.segmentId.slice(1)) * 300
      return { segmentId: part.segmentId, start, end: start + part.quote.length, quote: part.quote, hash: runtimeJson({ text: part.quote }).hash }
    }),
  } : null }
}

export const continuitySemanticRule = `核对完整动作关系和状态进展：方向冲突只在同一人物操作同一物体/控制件、同一时段且没有明确改令或反向操作解释时成立；不同物体、不同视角、明确撤回旧指令后逆操作不算矛盾。准备、打算、朝目的地移动不证明已完成或已到达；距离/方位/持有者须核对整个主张，不能用相邻正确半句支持错误定位。正文中的计划、引用、人物猜测不能当实况。除 findings 外输出 semanticChecks，恰好包含 action_direction 与 state_progression 各一项：{kind,result,reason,findingIndexes}。result 为 clear、conflict 或 not_applicable；逐项说明实际核对关系；conflict 专指正文之间的实际矛盾，必须引用 findings 中有原文证据的 error 索引，其他结果索引为空。仅终态候选夸大正文时，在 terminalVerdicts 标记 planned/unknown/negated，不把候选伪装成正文引文来制造 error。不臆造矛盾，无适用动作时说明 not_applicable。`

const semanticCheckSchema = z.object({ kind: z.enum(['action_direction', 'state_progression']),
  result: z.enum(['clear', 'conflict', 'not_applicable']), reason: z.string().trim().min(1).max(1500),
  findingIndexes: z.array(z.number().int().nonnegative()).max(20),
}).strict()
export function validContinuitySemanticChecks(raw: unknown, findings: Array<{ severity: string }>) {
  const parsed = z.array(semanticCheckSchema).length(2).safeParse(raw)
  return parsed.success && new Set(parsed.data.map(item => item.kind)).size === 2
    && parsed.data.every(item => item.result === 'conflict'
      ? item.findingIndexes.length > 0 && new Set(item.findingIndexes).size === item.findingIndexes.length
        && item.findingIndexes.every(index => findings[index]?.severity === 'error')
      : item.findingIndexes.length === 0)
}
