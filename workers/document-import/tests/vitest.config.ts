import { defineConfig } from 'vitest/config'

// Standalone worker protocol suite: no application boot, database setup, dotenv or production config.
export default defineConfig({ test: { environment: 'node', include: ['workers/document-import/tests/**/*.test.ts'],
  pool: 'forks', fileParallelism: false, testTimeout: 10_000 } })
