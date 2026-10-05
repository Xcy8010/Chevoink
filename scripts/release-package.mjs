import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const productionSourcePath = value => /^(api|shared|prisma)\//.test(value)
  || ['.node-version', 'package.json', 'package-lock.json', 'ecosystem.config.cjs'].includes(value)
const digest = value => createHash('sha256').update(value).digest('hex')

export function archiveRevision(revision, archive, root) {
  // Windows checkout settings must not rewrite committed LF bytes in releases.
  execFileSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar.gz', `--output=${archive}`, revision], { cwd: root })
}

export function sourceManifest(revision, root) {
  const entries = execFileSync('git', ['ls-tree', '-r', '-z', revision], { cwd: root }).toString().split('\0')
    .filter(Boolean).map(line => {
      const [metadata, filename] = line.split('\t')
      const [mode, type, oid] = metadata.split(' ')
      return { filename, mode, type, oid }
    }).filter(entry => productionSourcePath(entry.filename))
  if (!entries.length || entries.some(entry => entry.type !== 'blob' || entry.mode !== '100644')) {
    throw new Error('Unexpected production source tree')
  }
  const objects = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root, input: entries.map(entry => entry.oid).join('\n') + '\n', maxBuffer: 64 * 1024 * 1024,
  })
  let offset = 0
  return entries.map(entry => {
    const newline = objects.indexOf(10, offset)
    const [oid, type, sizeText] = objects.subarray(offset, newline).toString().split(' ')
    const size = Number(sizeText)
    if (newline < offset || oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Invalid Git object stream')
    }
    offset = newline + 1
    const bytes = objects.subarray(offset, offset + size)
    offset += size + 1
    return { path: entry.filename, sha256: digest(bytes) }
  })
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.length !== 6 || argv[0] !== '--revision' || argv[2] !== '--baseline' || argv[4] !== '--out') {
    throw new Error('Usage: release-package.mjs --revision SHA --baseline SHA --out NEW_DIRECTORY')
  }
  const [, revision, , baseline, , destination] = argv
  if (![revision, baseline].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Exact revisions required')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim() !== revision) throw new Error('HEAD mismatch')
  execFileSync('git', ['merge-base', '--is-ancestor', baseline, revision], { cwd: root })
  const files = sourceManifest(baseline, root)
  const out = path.resolve(destination)
  mkdirSync(out, { recursive: false })
  const archive = path.join(out, `chevoink-${revision}.tar.gz`)
  const baselineManifest = path.join(out, 'expected-baseline.json')
  archiveRevision(revision, archive, root)
  const result = { revision, baseline, archive, archiveSha256: digest(readFileSync(archive)), baselineManifest }
  writeFileSync(baselineManifest, JSON.stringify({ revision: baseline, files }) + '\n')
  writeFileSync(path.join(out, 'package.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
