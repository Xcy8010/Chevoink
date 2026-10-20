import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { CN_FICTION_EVAL_SCENARIOS, CN_FICTION_EVAL_VERSION } from '../tests/agent-evals/cn-fiction-scenarios.js'
import { evaluateSkillRouting } from '../tests/agent-evals/cn-fiction-metrics.js'
import { evaluateFiftyChapterBridge } from '../tests/agent-evals/chapter-bridge-metrics.js'
import { evaluateDeterministicHumanityGate } from '../tests/agent-evals/humanity-quality-metrics.js'
import { HUMANITY_CONTEXT_CORPUS_VERSION, HUMANITY_CONTEXT_SCENARIOS } from '../tests/agent-evals/humanity-context-scenarios.js'
import { evaluateCraftLibraryBaseline } from '../tests/agent-evals/craft-library-metrics.js'
import { getAgentToolManifest } from '../api/lib/agent/tools/registry.js'
import { getDurableToolAdapterNames } from '../api/lib/agent/runtime-tool-step.js'
import { CREATION_QUALITY_DIMENSIONS } from '../tests/agent-evals/reliable-creation-metrics.js'
import { BUILTIN_SKILL_PACK_VERSION, SKILL_ROUTER_VERSION } from '../api/lib/agent/skills/index.js'
import { AGENT35_REGRESSION_CORPUS, AGENT35_REGRESSION_CORPUS_VERSION } from '../tests/agent-evals/agent35-regression-corpus.js'

function readGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

const datasetHash = createHash('sha256').update(JSON.stringify(CN_FICTION_EVAL_SCENARIOS)).digest('hex')
const durableAdapters = new Set(getDurableToolAdapterNames())
const report = {
  schemaVersion: 'agent3-eval-report.v1',
  datasetVersion: CN_FICTION_EVAL_VERSION,
  datasetHash,
  codeSha: readGitSha(),
  model: process.env.AGENT3_EVAL_MODEL ?? 'deterministic-skill-router',
  temperature: Number(process.env.AGENT3_EVAL_TEMPERATURE ?? 0),
  skillCatalogVersion: BUILTIN_SKILL_PACK_VERSION,
  skillRouterVersion: SKILL_ROUTER_VERSION,
  generatedAt: new Date().toISOString(),
  routing: evaluateSkillRouting(CN_FICTION_EVAL_SCENARIOS),
  chapterBridge: evaluateFiftyChapterBridge(),
  humanityQuality: evaluateDeterministicHumanityGate(),
  humanityContext: { evidenceKind: 'synthetic_editorial_case_inventory', version: HUMANITY_CONTEXT_CORPUS_VERSION,
    cases: HUMANITY_CONTEXT_SCENARIOS, literaryQualityMeasured: false, paidCalls: 0 },
  craftLibrary: evaluateCraftLibraryBaseline(),
  reliableCreation: {
    evidenceKind: 'deterministic_contract_inventory',
    literaryQualityMeasured: false,
    providerAcceptanceMeasured: false,
    paidCalls: 0,
    regressionCorpus: { version: AGENT35_REGRESSION_CORPUS_VERSION, cases: AGENT35_REGRESSION_CORPUS },
    dimensions: CREATION_QUALITY_DIMENSIONS,
    tools: getAgentToolManifest().map(tool => ({ ...tool, executors: {
      legacy: 'registered', durable: durableAdapters.has(tool.name) ? 'adapter_registered' : 'not_adapted',
    } })),
  },
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
