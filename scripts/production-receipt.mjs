const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = () => { throw new Error('Production receipt is incomplete, stale or unrelated to this trusted run') }

/** Adapter routes these GETs to the connected GitHub tool's authenticated
 * run/jobs reads and decoded job-log read. No production credential is needed. */
export async function readProductionRun(runId, options, request) {
  if (!/^[1-9]\d*$/.test(String(runId)) || typeof request !== 'function') fail()
  const base = `repos/Xcy8010/Chevoink/actions/runs/${runId}`
  const run = await request(base)
  if (String(run?.id) !== String(runId)) fail()
  const report = await request(`${base}/jobs?filter=latest&per_page=100`)
  if (!Array.isArray(report?.jobs) || report.total_count !== report.jobs.length || report.jobs.length !== 2) fail()
  const admission = report.jobs.filter(job => job.name === 'admit')
  const executions = report.jobs.filter(job => job.name === 'deploy')
  if (admission.length !== 1 || executions.length !== 1 || String(admission[0].run_id) !== String(run.id)
    || admission[0].status !== 'completed' || admission[0].conclusion !== 'success') fail()
  const job = executions[0]
  if (!Number.isSafeInteger(job.id) || job.id < 1) fail()
  return readProductionReceipt(run, job, await request(`repos/Xcy8010/Chevoink/actions/jobs/${job.id}/logs`), options)
}

function logRecords(log, prefix) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024) fail()
  return log.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).flatMap(line => {
    // Ignore printed source/command snippets. Accept an actual timestamped log record.
    const body = /^\d{4}-\d\d-\d\dT\S+Z (.*)$/.exec(line)?.[1]
    return body?.startsWith(prefix + ' ') ? [JSON.parse(body.slice(prefix.length + 1))] : []
  })
}

/** Input must be obtained using authenticated GitHub run/job/log reads. This
 * validates the point-in-time witness; it is never a cache of current production. */
export function readProductionReceipt(run, job, log, { mode, requestId, requestSha, sourceSha, ciRunId, expectedRevision, now = Date.now(), maxAgeMs = 5 * 60 * 1000 } = {}) {
  const startedAt = Date.parse(run?.run_started_at), updatedAt = Date.parse(run?.updated_at)
  if (!['inspect', 'deploy'].includes(mode) || run?.repository?.full_name !== 'Xcy8010/Chevoink'
    || !sha(sourceSha) || !sha(requestSha) || sourceSha === requestSha || run.head_sha !== requestSha || !/^[1-9]\d*$/.test(String(ciRunId))
    || mode === 'deploy' && (!sha(expectedRevision) || expectedRevision === sourceSha)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId ?? '') || !/^[1-9]\d*$/.test(String(run.id))
    || run.display_title !== `${mode} ${sourceSha}${mode === 'deploy' ? ` over ${expectedRevision}` : ''} [${requestId}]` || !Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || updatedAt < startedAt
    || run.path !== '.github/workflows/cloud-deploy.yml' || run.event !== 'push' || run.head_branch !== 'main'
    || run.run_attempt !== 1 || !sha(run.head_sha) || run.status !== 'completed' || run.conclusion !== 'success'
    || String(job?.run_id) !== String(run.id) || job.name !== 'deploy' || job.status !== 'completed' || job.conclusion !== 'success'
    || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 5 * 60 * 1000) fail()
  const records = logRecords(log, 'CHEVOINK_PRODUCTION_RECEIPT')
  const phase = mode === 'inspect' ? 'preflight' : 'postflight'
  const matches = records.filter(value => value.phase === phase)
  if (matches.length !== 1) fail()
  const receipt = matches[0], at = Date.parse(receipt.observedAt)
  if (receipt.schemaVersion !== 1 || receipt.runId !== String(run.id) || receipt.requestId !== requestId || receipt.requestSha !== requestSha || receipt.sourceSha !== sourceSha || receipt.ciRunId !== String(ciRunId)
    || !sha(receipt.revision) || !digest(receipt.archiveSha256) || !digest(receipt.indexSha256) || !digest(receipt.manifestSha256)
    || !digest(receipt.processSha256) || receipt.runtime !== '22.23.2' || receipt.sourceVerified !== true
    || receipt.processVerified !== true || receipt.internalHealth !== true || receipt.publicHealth !== true || receipt.publicIndexVerified !== true
    || !Number.isSafeInteger(receipt.sourceFiles) || receipt.sourceFiles < 1 || !Number.isFinite(at) || at > now || now - at > maxAgeMs
    || at < startedAt || at > updatedAt + 1000) fail() // GitHub timestamps have second precision.
  const publications = logRecords(log, 'CHEVOINK_DEPLOYMENT_RECEIPT')
  if (mode === 'inspect') {
    if (records.length !== 1 || publications.length || receipt.journal !== null) fail()
  } else {
    const before = records.filter(value => value.phase === 'preflight')
    const publish = publications[0]
    if (records.length !== 2 || before.length !== 1 || publications.length !== 1
      || before[0].runId !== receipt.runId || before[0].requestId !== requestId || before[0].requestSha !== requestSha || before[0].sourceSha !== receipt.sourceSha || before[0].ciRunId !== String(ciRunId) || before[0].revision !== expectedRevision
      || before[0].revision === receipt.revision || !Number.isFinite(Date.parse(before[0].observedAt)) || Date.parse(before[0].observedAt) < startedAt
      || receipt.revision !== receipt.sourceSha || receipt.journal?.revision !== receipt.sourceSha || receipt.journal.lastPhase !== 'completed'
      || publish.schemaVersion !== 1 || publish.runId !== receipt.runId || publish.requestId !== requestId || publish.requestSha !== requestSha || publish.revision !== receipt.revision || publish.baseline !== expectedRevision
      || publish.archiveSha256 !== receipt.archiveSha256 || publish.publicIndexSha256 !== receipt.indexSha256 || publish.ciRunId !== String(ciRunId)
      || !Number.isFinite(Date.parse(receipt.serverObservedAt)) || !Number.isFinite(Date.parse(receipt.journal.completedAt))
      || Date.parse(receipt.journal.completedAt) > Date.parse(receipt.serverObservedAt)
      || !Number.isFinite(Date.parse(publish.verifiedAt)) || Date.parse(publish.verifiedAt) < Date.parse(before[0].observedAt) || Date.parse(publish.verifiedAt) > at) fail()
  }
  return receipt
}
