import { describe, expect, it, vi } from 'vitest'
import { readReleaseCi } from '../../scripts/release-ci-read.mjs'

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
