import { defineConfig } from 'vitest/config'

// No application/DB boot. Real supervised Node parsers run; native tests require an explicit image.
export default defineConfig({ test: { environment: 'node', include: [
  'tests/unit/novel-import-parser.test.ts', 'tests/unit/novel-import-isolated-parser.test.ts',
  'tests/unit/novel-import-native-parser.test.ts', 'workers/document-import/tests/**/*.test.ts',
], pool: 'forks', fileParallelism: false, testTimeout: 30_000 } })
