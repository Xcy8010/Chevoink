import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyDualAudit } from './audit-gate.mjs'

const report = (severity = 'low') => ({ auditReportVersion: 2,
  vulnerabilities: { example: { severity } },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, [severity]: 1, total: 1 }, dependencies: { total: 10 } } })
const retired = { method: 'POST', statusCode: 400, uri: 'https://registry.npmjs.org/-/npm/v1/security/audits/quick',
  body: { error: 'Bad Request', message: 'Invalid package tree, run npm install to rebuild your package-lock.json' } }
const input = () => ({ production: report(), productionOutcome: 'success', full: report(), fullOutcome: 'success' })
const unavailable = () => ({ ...input(), production: retired, productionOutcome: 'failure', productionStderr: 'npm notice This endpoint is being retired.' })

test('requires both independent complete reports at the unchanged high threshold', () => {
  assert.equal(verifyDualAudit(input()).gate, 'independent-audits')
  for (const key of ['production', 'full']) for (const severity of ['high', 'critical']) {
    assert.throws(() => verifyDualAudit({ ...input(), [key]: report(severity) }), /high\/critical/)
  }
})

test('retired production endpoint stays unavailable under a successful stricter full-tree audit', () => {
  const result = verifyDualAudit(unavailable())
  assert.equal(result.gate, 'full-tree-superset')
  assert.equal(result.production.status, 'unavailable')
  assert.equal(result.full.status, 'success')
  for (const fullOutcome of ['failure', 'skipped', 'cancelled', undefined]) {
    assert.throws(() => verifyDualAudit({ ...unavailable(), fullOutcome }))
  }
  assert.throws(() => verifyDualAudit({ ...unavailable(), full: report('high') }))
})

test('never substitutes for vulnerability, authentication, registry or unclassified failures', () => {
  for (const production of [report('high'), null, {}, { ...retired, statusCode: 401 },
    { ...retired, metadata: { vulnerabilities: { high: 1 } } },
    { ...retired, vulnerabilities: { example: { severity: 'high' } } },
    { ...retired, uri: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk' },
    { ...retired, uri: 'https://other.invalid/-/npm/v1/security/audits/quick' },
    { ...retired, body: { error: 'Bad Request', message: 'other error' } }]) {
    assert.throws(() => verifyDualAudit({ ...unavailable(), production }), /unclassified/)
  }
  assert.throws(() => verifyDualAudit({ ...unavailable(), productionStderr: '' }), /unclassified/)
  assert.throws(() => verifyDualAudit({ ...unavailable(), productionOutcome: 'cancelled' }), /unclassified/)
})

test('missing, inconsistent or empty full reports fail closed even on exit zero', () => {
  for (const full of [null, {}, { ...report(), error: {} }, { ...report(), vulnerabilities: {} },
    { ...report(), metadata: { vulnerabilities: report().metadata.vulnerabilities, dependencies: { total: 0 } } }]) {
    assert.throws(() => verifyDualAudit({ ...unavailable(), full }), /complete audit/)
  }
})

test('zero vulnerabilities requires an explicit complete empty map', () => {
  const zero = { auditReportVersion: 2, vulnerabilities: {}, metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: { total: 10 } } }
  assert.equal(verifyDualAudit({ ...input(), production: zero, full: zero }).gate, 'independent-audits')
  for (const vulnerabilities of [undefined, null, [], '']) {
    assert.throws(() => verifyDualAudit({ ...unavailable(), full: { ...zero, vulnerabilities } }), /complete audit/)
    assert.throws(() => verifyDualAudit({ ...input(), production: { ...zero, vulnerabilities } }), /complete audit/)
  }
})

test('reports the actual vulnerability gate when npm exits nonzero with a complete finding', () => {
  for (const severity of ['high', 'critical']) {
    assert.throws(() => verifyDualAudit({ ...input(), full: report(severity), fullOutcome: 'failure' }), /high\/critical vulnerability/)
  }
  assert.throws(() => verifyDualAudit({ ...input(), full: report('low'), fullOutcome: 'failure' }), /complete audit/)
})
