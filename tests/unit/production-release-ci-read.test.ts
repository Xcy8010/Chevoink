import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ghApi, readReleaseCi } from '../../scripts/release-ci-read.mjs'

const revision = 'a'.repeat(40), runId = '12345'
const names = ['plan test shards', 'check / lint / build / audit', 'merge coverage / test report', 'check / lint / test / build / audit',
  ...Array.from({ length: 12 }, (_, index) => `test shard ${index + 1}/12`)]
function evidence() {
  return { run: { id: Number(runId), repository: { full_name: 'Xcy8010/Chevoink' }, head_sha: revision,
    name: 'CI', status: 'completed', conclusion: 'success' }, report: { total_count: names.length,
    jobs: names.map((name, index) => ({ id: index + 1, run_id: Number(runId), name, status: 'completed', conclusion: 'success' })) } }
}
function reader(data = evidence()) {
  return vi.fn(async (endpoint: string) => endpoint.includes('/jobs?') ? data.report : endpoint.includes('/workflows/')
    ? { workflow_runs: [data.run] } : data.run)
}

describe('live release CI evidence admission', () => {
  it('reads the configured repository and every latest-attempt job before accepting the original gates', async () => {
    const request = reader(), result = await readReleaseCi(revision, runId, request)
    expect(result.ciRunId).toBe(runId)
    expect(result.ci.jobs).toHaveLength(16)
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      `repos/Xcy8010/Chevoink/actions/runs/${runId}`, `repos/Xcy8010/Chevoink/actions/runs/${runId}/jobs?filter=latest&per_page=100`])
  })
  it('discovers only a completed successful CI for the same SHA', async () => {
    const request = reader()
    expect((await readReleaseCi(revision, undefined, request)).ciRunId).toBe(runId)
    expect(request.mock.calls[0][0]).toContain(`head_sha=${revision}&status=success`)
    const data = evidence(); data.run.head_sha = 'b'.repeat(40)
    await expect(readReleaseCi(revision, undefined, reader(data))).rejects.toThrow('No completed successful CI')
  })
  it.each(['repository', 'run', 'sha', 'running', 'failed-shard', 'other-run-job', 'pagination', 'missing-shard'] as const)(
    'rejects %s evidence without granting packaging or deployment', async scenario => {
      const data = evidence()
      if (scenario === 'repository') data.run.repository.full_name = 'other/Chevoink'
      if (scenario === 'run') data.run.id++
      if (scenario === 'sha') data.run.head_sha = 'b'.repeat(40)
      if (scenario === 'running') data.run.status = 'in_progress'
      if (scenario === 'failed-shard') data.report.jobs.at(-1)!.conclusion = 'failure'
      if (scenario === 'other-run-job') data.report.jobs.at(-1)!.run_id++
      if (scenario === 'pagination') data.report.total_count++
      if (scenario === 'missing-shard') { data.report.jobs.pop(); data.report.total_count-- }
      await expect(readReleaseCi(revision, runId, reader(data))).rejects.toThrow()
    })
  it('rejects malformed IDs and propagates unavailable evidence', async () => {
    const request = reader()
    await expect(readReleaseCi(revision, '../123', request)).rejects.toThrow('Invalid CI run ID')
    await expect(readReleaseCi('bad-sha', runId, request)).rejects.toThrow('Invalid candidate SHA')
    expect(request).not.toHaveBeenCalled()
    await expect(readReleaseCi(revision, runId, async () => { throw new Error('API unavailable') })).rejects.toThrow('API unavailable')
  })
})


const token = 'gho_' + 'x'.repeat(36)
const base = `repos/Xcy8010/Chevoink/actions/runs/${runId}`
const endpoints = [base, `${base}/jobs?filter=latest&per_page=100`,
  `repos/Xcy8010/Chevoink/actions/workflows/ci.yml/runs?head_sha=${revision}&status=success&per_page=20`]
function eof(endpoint: string, stderr = `Get "https://api.github.com/${endpoint}": EOF\n`) {
  return Object.assign(new Error('GitHub transport failed'), { status: 1, stderr })
}
function fallback(endpoint: string, output = '{"observed":true}\n200') {
  return vi.fn().mockImplementationOnce(() => { throw eof(endpoint) }).mockReturnValueOnce(token + '\r\n').mockReturnValueOnce(output)
}
function assertRedacted(work: () => unknown, expected: string) {
  let failure: unknown
  try { work() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(expected)
  expect(inspect(failure, { showHidden: true, depth: 5 })).not.toContain(token)
  expect(failure).not.toHaveProperty('cause')
  expect(failure).not.toHaveProperty('stdout'); expect(failure).not.toHaveProperty('stderr'); expect(failure).not.toHaveProperty('input')
}
afterEach(() => { vi.restoreAllMocks() })

describe('bounded Windows native HTTPS metadata fallback', () => {
  it('keeps successful gh GET requests on the original identity without reading credentials or invoking curl', () => {
    const execute = vi.fn().mockReturnValue('{"observed":true}')
    expect(ghApi(base, { platform: 'win32', execute })).toEqual({ observed: true })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]).toMatchObject(['gh', ['api', base, '--hostname', 'github.com', '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'],
    { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }])
  })
  it.each(endpoints)('uses only stdin for the original token and strictly validated GET endpoint %s', endpoint => {
    const execute = fallback(endpoint)
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    expect(ghApi(endpoint, { platform: 'win32', execute })).toEqual({ observed: true })
    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls[1]).toMatchObject(['gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }])
    const [binary, argv, options] = execute.mock.calls[2]
    expect(binary.replace(/\\/g, '/')).toMatch(/\/System32\/curl\.exe$/i)
    expect(argv).toEqual(['--disable', '--config', '-'])
    expect(options).toMatchObject({ windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(options.input).toContain(`url = "https://api.github.com/${endpoint}"\n`)
    expect(options.input).toContain('request = "GET"\n')
    expect(options.input).toContain(`header = "Authorization: Bearer ${token}"\n`)
    expect(options.input).toContain('proto = "=https"\n')
    expect(options.input).toContain('connect-timeout = 15\nmax-time = 60\n')
    expect(options.input).toContain('write-out = "\\n%{http_code}"\n')
    expect(options.input).not.toMatch(/(?:insecure|location|retry|cacert|proxy|resolve|connect-to|url = [^"\n])/i)
    expect(execute.mock.calls.map(([file, args]) => JSON.stringify({ file, args })).join('')).not.toContain(token)
    expect(execute.mock.calls[0][2]).not.toHaveProperty('input')
    expect(execute.mock.calls[1][2]).not.toHaveProperty('input')
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
  it('recognizes the same explicit unexpected EOF transport failure exactly once', () => {
    const request = vi.fn().mockImplementationOnce(() => { throw eof(base, `Get "https://api.github.com/${base}": unexpected EOF`) })
      .mockReturnValueOnce(token + '\n').mockReturnValueOnce('{}\n200')
    expect(ghApi(base, { platform: 'win32', execute: request })).toEqual({})
    expect(request).toHaveBeenCalledTimes(3)
  })
  it.each(['linux', 'darwin'])('never falls back or reads a token on %s', platform => {
    const execute = fallback(base)
    assertRedacted(() => ghApi(base, { platform, execute }), 'GitHub CLI CI metadata request failed')
    expect(execute).toHaveBeenCalledOnce()
  })
  it.each([
    'HTTP 401: Bad credentials', 'HTTP 403: Resource not accessible', 'HTTP 404: Not Found', 'HTTP 429: Rate limit', 'HTTP 500: Server error',
    'TLS certificate verification failed', 'connection timed out', 'connection reset by peer',
    'Get "https://api.github.com/repos/other/repo/actions/runs/12345": EOF',
    `Get "https://api.github.com/${base}": EOF\nHTTP 403: Forbidden`,
  ])('rejects non-matching gh failure without fallback: %s', stderr => {
    const execute = vi.fn().mockImplementation(() => { throw Object.assign(new Error(token), { status: 1, stderr }) })
    assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'GitHub CLI CI metadata request failed')
    expect(execute).toHaveBeenCalledOnce()
  })
  it.each([null, 0, undefined])('does not turn timeout/startup/success status %s into EOF fallback', status => {
    const execute = vi.fn().mockImplementation(() => { throw Object.assign(eof(base), { status }) })
    assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'GitHub CLI CI metadata request failed')
    expect(execute).toHaveBeenCalledOnce()
  })
  it.each([
    'https://api.github.com/' + base, 'repos/other/Chevoink/actions/runs/12345', base + '/logs', base + '/rerun',
    base + '/artifacts', base + '/jobs?filter=all&per_page=100', base + '/jobs?filter=latest&per_page=100&extra=1',
    base + '/../jobs', base + '%2Flogs', base + '?redirect=https://attacker.invalid',
    'repos/Xcy8010/Chevoink/actions/workflows/other.yml/runs?head_sha=' + revision + '&status=success&per_page=20',
    endpoints[2] + '&page=2', endpoints[2].replace(revision, 'b'.repeat(39)),
  ])('rejects an unapproved endpoint before starting any child process: %s', endpoint => {
    const execute = vi.fn()
    expect(() => ghApi(endpoint, { platform: 'win32', execute })).toThrow('CI metadata endpoint is not allowed')
    expect(execute).not.toHaveBeenCalled()
  })
  it.each([token + '\nheader = "Injected: value"', token + '\rInjected', ' ' + token, token + '\n\n', token + '"', '', 'gho_' + 'x'.repeat(256)])(
    'rejects a non-single-line/invalid token without putting it in an error or invoking curl', invalid => {
      const execute = vi.fn().mockImplementationOnce(() => { throw eof(base) }).mockReturnValueOnce(invalid)
      assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'GitHub CLI returned an invalid authentication token')
      expect(execute).toHaveBeenCalledTimes(2)
    })
  it('sanitizes token-reader errors instead of exposing child stdout or spawn details', () => {
    const execute = vi.fn().mockImplementationOnce(() => { throw eof(base) }).mockImplementationOnce(() => {
      throw Object.assign(new Error(token), { stdout: token, stderr: token, input: token })
    })
    assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'GitHub CLI authentication is unavailable for CI metadata')
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it.each(['000', '301', '401', '403', '404', '429', '500', '200\n', ''])('rejects native HTTP status %s without replay or leaking a response body', status => {
    const execute = fallback(base, JSON.stringify({ message: token }) + '\n' + status)
    assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'Native HTTPS CI metadata did not return HTTP 200')
    expect(execute).toHaveBeenCalledTimes(3)
  })
  it.each(['gh', 'curl'] as const)('rejects malformed %s JSON without logging response snippets or repeating a request', transport => {
    const execute = transport === 'gh' ? vi.fn().mockReturnValue('invalid ' + token) : fallback(base, 'invalid ' + token + '\n200')
    assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'GitHub CI metadata response is not valid JSON')
    expect(execute).toHaveBeenCalledTimes(transport === 'gh' ? 1 : 3)
  })
  it('sanitizes native process errors, including echoed stdin/headers, and never retries the fallback', () => {
    const execute = vi.fn().mockImplementationOnce(() => { throw eof(base) }).mockReturnValueOnce(token + '\n').mockImplementationOnce(() => {
      throw Object.assign(eof(base), { message: token, stdout: token, stderr: token, input: token, spawnargs: [token] })
    })
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    assertRedacted(() => ghApi(base, { platform: 'win32', execute }), 'Native HTTPS CI metadata request failed')
    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls.map(([file, args]) => JSON.stringify({ file, args })).join('')).not.toContain(token)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
  it.each(['explicit', 'discovered', 'failed-gate'] as const)('keeps original same-SHA and full-job admission after %s native reads', async mode => {
    const data = evidence()
    if (mode === 'failed-gate') data.report.jobs.at(-1)!.conclusion = 'failure'
    const execute = vi.fn((file: string, args: string[], options: { input?: string }) => {
      if (file === 'gh' && args[0] === 'api') throw eof(args[1])
      if (file === 'gh' && args[0] === 'auth') return token + '\n'
      const payload = options.input?.includes('/jobs?') ? data.report : options.input?.includes('/workflows/') ? { workflow_runs: [data.run] } : data.run
      return JSON.stringify(payload) + '\n200'
    })
    const result = readReleaseCi(revision, mode === 'discovered' ? undefined : runId, (endpoint: string) => ghApi(endpoint, { platform: 'win32', execute }))
    if (mode === 'failed-gate') await expect(result).rejects.toThrow('Every CI job must complete successfully')
    else expect((await result).ci.jobs).toHaveLength(16)
    expect(execute).toHaveBeenCalledTimes(mode === 'discovered' ? 9 : 6)
    for (const [file, args, options] of execute.mock.calls) {
      expect(JSON.stringify({ file, args })).not.toContain(token)
      if (file === 'gh') expect(options).not.toHaveProperty('input')
    }
  })
})
