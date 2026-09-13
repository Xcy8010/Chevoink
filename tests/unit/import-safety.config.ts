import { defineConfig } from 'vitest/config'

// Explicit hermetic subset, NOT a substitute for DB integration/release checks.
// No globalSetup/database preflight and no application server startup.
export default defineConfig({ test: {
  environment: 'node', pool: 'forks', fileParallelism: false,
  setupFiles: ['tests/unit/import-safety.setup.ts'],
  include: ['tests/unit/import-active-data-scope.test.ts', 'tests/unit/agent-chapter-archive-guards.test.ts',
    'tests/unit/import-stale-writers.test.ts', 'tests/unit/chapter-publish-snapshot.test.ts', 'tests/unit/agent-request-queue.test.ts',
    'tests/unit/agent3-humanity-quality.test.ts', 'tests/unit/agent-chapter-placement.test.ts', 'tests/unit/agent3-story-compiler-contracts.test.ts',
    'tests/unit/agent-resume-budget-recovery.test.ts', 'tests/unit/memory-source.test.ts',
    'tests/unit/import-style-learning-fence.test.ts', 'tests/unit/style-learning-worker.test.ts'],
} })
