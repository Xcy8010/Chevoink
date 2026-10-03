import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { appendFile, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const vendorRoot = fileURLToPath(new URL('../vendor/braces/', import.meta.url))
type Options = { maxDepth?: number | string | null; escapeInvalid?: boolean }
type Ast = { type: string; value?: string; nodes?: Ast[]; parent?: Ast; open?: boolean; close?: boolean; commas?: number }
type Braces = Record<'parse' | 'compile' | 'expand' | 'stringify' | 'create', (input: string | Ast, options?: Options) => unknown>
const braces = require('braces') as Braces
const nest = (depth: number, open = '{', close = '}') => open.repeat(depth) + 'a,b' + close.repeat(depth)
const ast = (depth: number): Ast => {
  let node: Ast = { type: 'text', value: 'a' }
  for (let i = 0; i < depth; i++) {
    const parent: Ast = { type: 'brace', nodes: [node], open: true, close: true, commas: 1 }
    node.parent = parent
    node = parent
  }
  const root: Ast = { type: 'root', nodes: [node] }
  node.parent = root
  return root
}

describe('private braces depth-security backport', () => {
  it('installs the private derivative and verifies its committed source integrity', () => {
    expect(realpathSync(path.dirname(require.resolve('braces/package.json')))).toBe(realpathSync(vendorRoot))
    expect(require('braces/package.json')).toMatchObject({ name: 'braces', version: '3.0.3-chevoink.1', private: true, license: 'MIT' })
    const manifest = JSON.parse(readFileSync(path.join(vendorRoot, 'INTEGRITY.json'), 'utf8')) as { files: Record<string, string> }
    expect(Object.keys(manifest.files).sort()).toEqual([
      '.gitattributes', 'index.js', 'lib/compile.js', 'lib/constants.js', 'lib/expand.js', 'lib/parse.js', 'lib/stringify.js', 'lib/utils.js', 'LICENSE', 'README.md', 'package.json', 'PROVENANCE.md',
    ].sort())
    for (const [filename, sha256] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(path.join(vendorRoot, filename))).digest('hex'), filename).toBe(sha256)
    }
  })

  for (const method of ['parse', 'compile', 'expand', 'stringify', 'create'] as const) {
    it.each([101, 4000])(`${method} rejects excessive brace and parenthesis string depth %i`, depth => {
      expect(() => braces[method](nest(depth))).toThrow(/Input depth \(101\), exceeds max depth \(100\)/)
      expect(() => braces[method](nest(depth, '(', ')'))).toThrow(/Input depth \(101\), exceeds max depth \(100\)/)
    })
    it(`${method} accepts the 100-level boundary and counts mixed nesting`, () => {
      expect(() => braces[method](nest(100))).not.toThrow()
      expect(() => braces[method](nest(100, '(', ')'))).not.toThrow()
      expect(() => braces[method]('{('.repeat(51) + 'a,b' + ')}'.repeat(51))).toThrow(/exceeds max depth/)
    })
    it(`${method} respects smaller, fractional and zero limits`, () => {
      expect(() => braces[method](nest(2), { maxDepth: 1.5 })).toThrow(/max depth \(1\)/)
      expect(() => braces[method](nest(2, '(', ')'), { maxDepth: 1.5 })).toThrow(/max depth \(1\)/)
      expect(() => braces[method](nest(1), { maxDepth: 0 })).toThrow(/max depth \(0\)/)
      expect(() => braces[method](nest(2), { maxDepth: 2 })).not.toThrow()
    })
    it(`${method} cannot disable the safe cap with oversized or non-finite limits`, () => {
      for (const maxDepth of [1000, Infinity, NaN, '1000', null]) {
        expect(() => braces[method](nest(101), { maxDepth })).toThrow(/max depth \(100\)/)
      }
    })
  }

  for (const method of ['compile', 'expand', 'stringify'] as const) {
    it.each([101, 4000])(`${method} rejects caller-supplied AST depth %i`, depth => {
      expect(() => braces[method](ast(depth))).toThrow(/AST depth \(101\), exceeds max depth \(100\)/)
    })
    it(`${method} guards child-node cycles and direct AST/subtree boundaries`, () => {
      const cycle: Ast = { type: 'root', nodes: [] }
      cycle.nodes!.push(cycle)
      expect(() => braces[method](cycle)).toThrow(/AST depth \(101\), exceeds max depth \(100\)/)
      expect(() => braces[method](ast(100))).not.toThrow()
      expect(() => braces[method](ast(100).nodes![0])).not.toThrow()
      expect(() => braces[method](ast(2), { maxDepth: 1.5 })).toThrow(/max depth \(1\)/)
      expect(() => braces[method](ast(101), { maxDepth: 1000 })).toThrow(/max depth \(100\)/)
    })
  }

  it.each([
    ['src/**/*.{ts,tsx}', 'src/**/*.(ts|tsx)', ['src/**/*.ts', 'src/**/*.tsx']],
    ['file-{01..03}.txt', 'file-(0[1-3]).txt', ['file-01.txt', 'file-02.txt', 'file-03.txt']],
    ['a/{b,c}/d', 'a/(b|c)/d', ['a/b/d', 'a/c/d']],
    ['*(a|{b|c,d})', '*(a|(b|c|d))', ['*(a|b|c)', '*(a|d)']],
    ['{a,{b,{c}}}', '(a|(b|{c}))', ['a', 'b', '{c}']],
    ['{a,b', '{a,b', ['{a,b']],
    ['[{}]', '[{}]', ['[{}]']],
  ])('preserves released compile and expand behavior for %s', (pattern, compiled, expanded) => {
    expect(braces.compile(pattern as string)).toBe(compiled)
    expect(braces.expand(pattern as string)).toEqual(expanded)
  })
  it.each(['{{a}}', '{a,{b}}', '{{x}y}', '{a,{b,{c}}}', '{}{a}', '{1..8}'])('preserves released escapeInvalid stringify parent semantics: %s', pattern => {
    expect(braces.stringify(pattern, { escapeInvalid: true })).toBe(pattern)
    expect(braces.stringify(braces.parse(pattern) as Ast, { escapeInvalid: true })).toBe(pattern)
  })
  it('keeps escaped, quoted and bracketed braces literal instead of counting them as nesting', () => {
    for (const pattern of ['\\{'.repeat(101), '"' + '{'.repeat(101) + '"', '[' + '{'.repeat(101) + ']']) {
      expect(() => braces.compile(pattern, { maxDepth: 0 })).not.toThrow()
    }
  })

  it('resolves the patched code through all three Tailwind and nodemon consumer paths', () => {
    const tailwindRequire = createRequire(require.resolve('tailwindcss'))
    const nodemonRequire = createRequire(require.resolve('nodemon'))
    for (const [parentRequire, dependency] of [[tailwindRequire, 'micromatch'], [tailwindRequire, 'chokidar'], [nodemonRequire, 'chokidar']] as const) {
      const consumerRequire = createRequire(parentRequire.resolve(dependency))
      expect(realpathSync(consumerRequire.resolve('braces'))).toBe(realpathSync(path.join(vendorRoot, 'index.js')))
      const consumed = consumerRequire('braces') as Braces
      expect(() => consumed.compile(nest(101))).toThrow(/exceeds max depth/)
      expect(consumed.expand('file-{1..3}.txt')).toEqual(['file-1.txt', 'file-2.txt', 'file-3.txt'])
    }
    const micromatch = tailwindRequire('micromatch') as ((paths: string[], pattern: string) => string[])
    expect(micromatch(['src/a.ts', 'src/b.tsx', 'src/c.js'], 'src/*.{ts,tsx}')).toEqual(['src/a.ts', 'src/b.tsx'])
  })
  it('builds representative Tailwind utilities with the patched glob dependency', async () => {
    const tailwind = require('tailwindcss') as typeof import('tailwindcss')
    const output = await postcss([tailwind({ content: [{ raw: '<div class="text-red-500 md:block"></div>', extension: 'html' }], corePlugins: { preflight: false } })]).process('@tailwind utilities;', { from: undefined })
    expect(output.css).toContain('.text-red-500')
    expect(output.css).toContain('.md\\:block')
  }, 30_000)
  it('watches brace-expanded files through nodemon’s actual chokidar dependency and closes its resources', async () => {
    const nodemonRequire = createRequire(require.resolve('nodemon'))
    const chokidar = nodemonRequire('chokidar') as typeof import('chokidar')
    const directory = await mkdtemp(path.join(os.tmpdir(), 'chevoink-braces-watch-'))
    const filenames = ['one.txt', 'two.md', 'ignored.log']
    const added: string[] = []
    let watcher: import('chokidar').FSWatcher | undefined
    const waitForEvent = (event: 'ready' | 'change') => new Promise<string | undefined>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); watcher!.off(event, onEvent); watcher!.off('error', onError) }
      const onEvent = (filename?: string) => { clean(); resolve(filename) }
      const onError = (error: Error) => { clean(); reject(error) }
      const timer = setTimeout(() => onError(new Error(`Timed out waiting for watcher ${event}`)), 3000)
      watcher!.once(event, onEvent)
      watcher!.once('error', onError)
    })
    try {
      for (const filename of filenames) await writeFile(path.join(directory, filename), 'fixture')
      watcher = chokidar.watch(path.join(directory, '*.{txt,md}'), { usePolling: true, interval: 50 })
      watcher.on('add', filename => added.push(path.basename(filename)))
      await waitForEvent('ready')
      expect(added.sort()).toEqual(['one.txt', 'two.md'])
      const changed = waitForEvent('change')
      await appendFile(path.join(directory, 'one.txt'), ' changed')
      expect(await changed).toBe(path.join(directory, 'one.txt'))
    } finally {
      await watcher?.close()
      for (const filename of filenames) await unlink(path.join(directory, filename))
      await rmdir(directory)
    }
  }, 10_000)
})
