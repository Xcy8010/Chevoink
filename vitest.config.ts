import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export const ciCoverageThresholds = { statements: 30, branches: 73, functions: 52, lines: 30 } as const
const coverageThresholds = process.env.CI
  ? ciCoverageThresholds
  : { statements: 10, branches: 59, functions: 15, lines: 10 }

export default defineConfig({
  // 与 tsconfig paths 对齐：前端模块（如 panel-helpers）内部使用 @/ 别名
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // forks 池每 worker 独立进程：进程内缓存（封禁/令牌版本/限流 Map）互不串扰，
    // 也避免全局 PrismaClient 单例跨测试文件复用连接
    pool: 'forks',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      // Vitest 4 移除了 coverage.all，默认只统计本次运行加载过的文件。
      // 这里显式复刻 Vitest 3 的全量口径（include 全部文件 + 原默认排除集），
      // 让 2026-09-08 校准的门槛分母保持可比，不借口径变化虚增百分比。
      include: ['**'],
      exclude: [
        'coverage/**',
        'dist/**',
        '**/node_modules/**',
        '**/[.]**',
        'packages/*/test?(s)/**',
        '**/*.d.ts',
        '**/virtual:*',
        '**/__x00__*',
        // Vitest 4's picomatch strips literal NUL bytes from glob patterns.
        // Keep the virtual-file exclusion without turning it into **/*.
        '**/[\\x00]*',
        'cypress/**',
        'test?(s)/**',
        'test?(-*).?(c|m)[jt]s?(x)',
        '**/*{.,-}{test,spec,bench,benchmark}?(-d).?(c|m)[jt]s?(x)',
        '**/__tests__/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
        '**/vitest.{workspace,projects}.[jt]s?(on)',
        '**/.{eslint,mocha,prettier}rc.{?(c|m)js,yml}',
      ],
      reporter: ['text', 'json-summary', 'html'],
      reportOnFailure: true,
      // CI 带 PostgreSQL，锁定已验证的 2026-09-08 基线下限；40%仍是未完成目标，不改变覆盖分母来达标。
      // 两档都只允许后续抬高，不允许靠删测试或关闭 DB 用例降线。
      thresholds: coverageThresholds,
    },
  },
})
