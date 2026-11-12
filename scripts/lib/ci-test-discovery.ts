export const testInclude = ['tests/**/*.test.ts', 'tests/**/*.test.tsx']

// Expanded Vitest 3.2.7 defaults so Vitest and Git pathspecs use the same
// exclusions without relying on brace expansion in Git.
export const testExclude = [
  ...['node_modules', 'dist', 'cypress', '.idea', '.git', '.cache', '.output', '.temp']
    .map(directory => `**/${directory}/**`),
  ...['karma', 'rollup', 'webpack', 'vite', 'vitest', 'jest', 'ava', 'babel', 'nyc', 'cypress', 'tsup', 'build', 'eslint', 'prettier']
    .map(tool => `**/${tool}.config.*`),
]
