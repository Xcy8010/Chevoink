/** Synthetic/deidentified contract inventory. Passing evidence comes from the
 * complete same-revision test run, never from the presence of a file here. */
export const AGENT35_REGRESSION_CORPUS_VERSION = '3.5.0'
const unit = (name: string) => `tests/unit/${name}.test.ts`
const integration = (name: string) => `tests/integration/${name}.test.ts`
export const AGENT35_REGRESSION_CORPUS = [
  ['F01', 'unique repeated-text anchors', [unit('chapter-atomic-patches')]],
  ['F02', 'UTF16 ranges and preserved prefix/suffix', [integration('agent-selection-effect')]],
  ['F03', 'overlap and atomic batch rejection', [unit('chapter-atomic-patches'), integration('agent-selection-effect')]],
  ['F04', 'truncated native call is non-executable', [integration('agent-durable-runtime-model')]],
  ['F05', 'chapter/task identity binding', [integration('agent-writing-scope')]],
  ['F06', 'distinct object and stale literal evidence', [unit('continuity-finding-authority'), unit('continuity-review-context')]],
  ['F07', 'plans are not confirmed facts; author hard constraints remain hard', [unit('continuity-finding-authority')]],
  ['F08', 'actual evidence source and correction', [unit('quality-evidence-correction'), unit('memory-source')]],
  ['F09', 'strict decisions do not waive current mandatory checks', [integration('agent-writing-scope')]],
  ['F10', 'forbidden edits and unsupported locality do not enlarge permission', [unit('agent-local-edit-scope'), integration('agent-selection-effect')]],
  ['F11', 'stale report cannot certify new body', [integration('agent-durable-runtime-quality')]],
  ['F12', 'incomplete checks and limited delivery remain distinct', [integration('agent-durable-runtime-completion')]],
  ['F13', 'limited delivery does not fabricate readiness', [integration('agent-runtime-until-completion')]],
  ['F14', 'dispatch/send interruptions and unknown do not resend', [integration('agent-durable-runtime-model')]],
  ['F15', 'effect/receipt/reducer/projection replay is idempotent', [integration('agent-durable-body-recovery')]],
  ['F16', 'lease and cancelled owner fencing', [integration('agent-durable-runtime-foundation'), integration('agent-durable-runtime-worker')]],
  ['F17', 'unknown usage and frozen configuration stay intact', [integration('agent-durable-runtime-model')]],
  ['F18', 'child limitations cannot fulfil parent completion', [integration('agent-durable-child')]],
  ['F19', 'old protocol and immutable skill resources recover', [integration('agent-skill-frozen-resources'), integration('agent-durable-runtime-quality')]],
  ['F20', 'journal restore and task ownership', [integration('agent-event-journal'), unit('agent-event-persistence')]],
  ['F21', 'compaction retains native pairs and authorization', [unit('context-compaction-boundary'), unit('agent-context-budget')]],
  ['F22', 'actual request encoding and unknown capability', [unit('agent-provider-compatibility')]],
  ['F23', 'no-progress guards survive aliases and reads', [integration('agent-durable-runtime-stagnation')]],
  ['F24', 'no-op creates no body version or secondary effect', [unit('chapter-atomic-patches'), integration('agent-selection-effect')]],
  ['F25', 'author-facing activity and historical projection', ['tests/unit/agent-author-view.test.tsx']],
  ['F26', 'tool prose does not fabricate author reasoning', ['tests/unit/agent-author-view.test.tsx']],
  ['F27', 'quoted English prose and report details survive projection', ['tests/unit/agent-author-view.test.tsx', 'tests/unit/agent-review-report-display.test.tsx']],
  ['F28', 'registered tools retain authorization', [unit('agent-tool-authority'), integration('agent-durable-runtime-tools')]],
  ['F29', 'provider matrix evidence remains offline', [unit('agent-provider-compatibility')]],
  ['F30', 'reuse only reports for the same lawful current inputs', [integration('agent-durable-runtime-quality')]],
  ['F31', 'full manuscript plus diff paired blind-review contracts', [unit('agent3-blind-review'), integration('agent3-blind-review')]],
  ['F32', 'all failures/unfinished costs and stage waits retain denominators', [unit('agent-creation-eval'), unit('agent-context-cache-layout')]],
] as const
