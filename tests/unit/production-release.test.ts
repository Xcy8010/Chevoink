import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertReleaseCi } from '../../scripts/release-ci.mjs'
import { archiveRevision, productionSourcePath, sourceManifest } from '../../scripts/release-package.mjs'

const sha = 'a'.repeat(40)
function ci(count = 10) {
  return { headSha: sha, workflowName: 'CI', status: 'completed', conclusion: 'success', jobs:
    ['plan test shards', 'check / lint / build / audit', 'merge coverage / test report', 'check / lint / test / build / audit',
      ...Array.from({ length: count }, (_, i) => `test shard ${i + 1}/${count}`)]
      .map(name => ({ name, status: 'completed', conclusion: 'success' })) }
}
describe('production release gates', () => {
  it.each([10, 13, 20])('accepts a complete successful %i-shard candidate', count => {
    expect(assertReleaseCi(ci(count), sha)).toEqual({ revision: sha, testShards: count })
  })
  it.each(['headSha', 'workflowName', 'status', 'conclusion'] as const)('rejects mismatched %s before deployment', field => {
    expect(() => assertReleaseCi({ ...ci(), [field]: 'wrong' }, sha)).toThrow()
  })
  it.each(['failure', 'skipped', 'cancelled', null])('rejects a %s gate even with a successful run summary', conclusion => {
    const evidence = ci(); Object.assign(evidence.jobs[2], { conclusion })
    expect(() => assertReleaseCi(evidence, sha)).toThrow()
  })
  it('rejects missing, duplicate and inconsistent shard sets', () => {
    for (const kind of ['missing', 'duplicate', 'different-count']) {
      const evidence = ci()
      if (kind === 'missing') evidence.jobs.pop()
      if (kind === 'duplicate') evidence.jobs[5].name = evidence.jobs[4].name
      if (kind === 'different-count') evidence.jobs[5].name = 'test shard 2/20'
      expect(() => assertReleaseCi(evidence, sha)).toThrow()
    }
  })
  it('rejects missing aggregate gate and unexpected jobs', () => {
    const evidence = ci(); evidence.jobs[3].name = 'some success message'
    expect(() => assertReleaseCi(evidence, sha)).toThrow()
    expect(() => assertReleaseCi({ ...ci(), jobs: [...ci().jobs, { name: 'unknown', status: 'completed', conclusion: 'success' }] }, sha)).toThrow()
  })
})
describe('committed production source identity', () => {
  it('compares canonical committed bytes, including removed-source baseline, without packaging local secrets/drafts', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'chevoink-package-test-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim()
    git('init', '--quiet'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'release@example.invalid')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(path.join(root, 'package.json'), '{"committed":true}\n')
    git('add', 'package.json'); git('commit', '--quiet', '-m', 'fixture')
    const revision = git('rev-parse', 'HEAD')
    writeFileSync(path.join(root, 'package.json'), '{"localDraft":true}\r\n')
    writeFileSync(path.join(root, '.env'), 'private-test-only')
    const manifest = sourceManifest(revision, root)
    expect(manifest).toEqual([{ path: 'package.json', sha256: '134ade3b071133f8969374f37f243180ba97f128538cec6c934a336ca269e3da' }])
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('private-test-only')
    expect(productionSourcePath('.env')).toBe(false)
    expect(productionSourcePath('output/private.json')).toBe(false)
    git('config', 'core.autocrlf', 'true')
    const archive = path.join(root, 'release.tar.gz')
    archiveRevision(revision, archive, root)
    expect(execFileSync('tar', ['-xOf', archive, 'package.json']).toString()).toBe('{"committed":true}\n')
    expect(execFileSync('tar', ['-tzf', archive]).toString().trim()).toBe('package.json')
  })
})
