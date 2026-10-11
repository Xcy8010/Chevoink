import type { TaskSpec } from './contracts/task-spec-contracts.js'

/** Diagnostic facts only. This view grants no action and is not a completion
 * certificate. It is never stored in a frozen execution frame or receipt. */
export type AgentCreationState = {
  version: 1
  consistency: 'repeatable_read'
  observedAt: string
  subject: { userId: string; novelId: string; runId: string }
  original: { taskId: string; sourceRunId: string; parentRunId: string | null; prompt: string | null;
    /** Hash of this view's original prompt/spec, not the frozen root inputHash. */
    contract: TaskSpec | null; projectionHash: string }
  execution: { protocol: 'legacy' | 'durable'; status: string; cursor:
    | { kind: 'durable_frame'; revision: number; hash: string }
    | { kind: 'legacy_checkpoint'; version: number; hash: string }
    | { kind: 'unknown' } }
  targets: Array<{
    /** contentHash uses the existing runtimeJson({ content }) envelope. */
    orderIndex: number; chapterId: string | null; revision: number | null; contentHash: string | null
    compilation: { id: string; status: string; stage: string; committedRevision: number | null } | null
    review: null | { source: 'persisted_current_review'; continuity: string; quality: string;
      requiredChecks: string[]; decisionPending: boolean; mustPassPending: boolean;
      requiredDecisions: Array<{ source: string; reportId: string; findingId: string }>
      retainedDecisions: Array<{ source: string; reportId: string; findingId: string; reason: string }>
      details: Array<{ source: string; reportId: string; findingId: string; evidence: string;
        explanation: string; suggestion: string; severity: string; disposition: string }>
      binding: { contentHash: string; continuityBinding: string; qualityReportId: string | null; qualityReportHash: string | null } | null }
    unknownReason: 'target_unbound' | 'target_missing' | 'review_unavailable' | 'CONTINUITY_INPUT_STALE' | null
  }>
  effects: { legacy: 'unknown' | 'not_applicable'; operations: Array<{
    id: string; action: string; status: string; receiptHash: string | null;
    receiptState: 'missing' | 'hash_verified'; observation: 'reduced_verified' | 'not_verified'
    outcome: 'succeeded' | 'failed' | 'unknown'
  }> }
  pending: { operations: Array<{ id: string; action: string; status: string }>;
    reviews: Array<{ compilationId: string | null; chapterId: string; revision: number; toolName: string; callId: string }> | null }
  localRestrictions: { source: 'legacy_checkpoint' | 'unknown';
    items: Array<{ action: string; target: string | null; code: string; reason: string; inputHash?: string;
      reviewInput?: { chapterId: string; revision: number } }> | null }
  usage: { coverage: 'saved_records_only'; observations: Array<{
    id: string; source: 'legacy_usage' | 'durable_attempt'; status: string; settlementStatus: string | null;
    /** Reported input/output counts; this alone does not verify cost or finality. */
    usageSource: string | null; tokensKnown: boolean; pendingSettlement: boolean
  }> }
  /** Persisted run status/outcome only, not a fresh manuscript acceptance. */
  delivery: { source: 'run_record'; status: string; limitation: string | null; verified: false }
  /** Original obligations retain their identity and are not certified by this view. */
  obligations: { source: 'original_contract'; verification: 'unverified'; goals: TaskSpec['goals'];
    expectedOutputs: TaskSpec['expectedOutputs']; postconditions: TaskSpec['postconditions']; hardConstraints: TaskSpec['hardConstraints'] } | null
}
