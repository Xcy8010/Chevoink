import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const levels = ['info', 'low', 'moderate', 'high', 'critical']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function verifiedReport(report, outcome, label) {
  const counts = report?.metadata?.vulnerabilities
  const entries = Object.values(report?.vulnerabilities ?? {})
  if (!record(report) || report.auditReportVersion !== 2 || report.error
    || !record(report.metadata) || !record(report.vulnerabilities) || !record(counts)
    || !levels.every(level => Number.isSafeInteger(counts[level]) && counts[level] >= 0)
    || counts.total !== levels.reduce((sum, level) => sum + counts[level], 0)
    || entries.length !== counts.total
    || !levels.every(level => entries.filter(entry => entry?.severity === level).length === counts[level])
    || !Number.isSafeInteger(report?.metadata?.dependencies?.total) || report.metadata.dependencies.total <= 0) {
    throw new Error(`${label}: npm did not return a successful complete audit report`)
  }
  if (counts.high || counts.critical) throw new Error(`${label}: high/critical vulnerability gate failed`)
  if (outcome !== 'success') throw new Error(`${label}: npm did not return a successful complete audit report`)
  return { status: 'success', vulnerabilities: counts, dependencies: report.metadata.dependencies }
}

export function verifyDualAudit({ production, productionOutcome, productionStderr = '', full, fullOutcome }) {
  // The official full-tree audit includes production dependencies. It must
  // succeed even when the production-only request succeeded independently.
  const all = verifiedReport(full, fullOutcome, 'full dependency audit')
  if (productionOutcome === 'success') {
    return { production: verifiedReport(production, productionOutcome, 'production dependency audit'), full: all, gate: 'independent-audits' }
  }
  // npm 10 falls back from Bulk Advisory to the retired Quick endpoint. This
  // exact infrastructure failure is not evidence of a damaged lock or safety.
  // Keep it unavailable and require the stricter official full-tree result.
  if (productionOutcome !== 'failure' || !record(production) || 'auditReportVersion' in production
    || 'metadata' in production || 'vulnerabilities' in production
    || production?.method !== 'POST' || production?.statusCode !== 400
    || production?.uri !== 'https://registry.npmjs.org/-/npm/v1/security/audits/quick'
    || production?.body?.error !== 'Bad Request'
    || !/^Invalid package tree\b/.test(production?.body?.message ?? '')
    || !/endpoint is being retired/i.test(productionStderr)) {
    throw new Error('production dependency audit: unclassified failure; release remains blocked')
  }
  return { production: { status: 'unavailable', reason: 'retired-quick-endpoint', httpStatus: 400 }, full: all, gate: 'full-tree-superset' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcomes = { productionOutcome: process.env.PRODUCTION_AUDIT_OUTCOME, fullOutcome: process.env.FULL_AUDIT_OUTCOME }
  const readReport = path => {
    try { return JSON.parse(readFileSync(path, 'utf8')) }
    catch { throw new Error(`${path}: missing or invalid JSON audit report`) }
  }
  try {
    const result = verifyDualAudit({
      ...outcomes,
      production: readReport('audit-production.json'),
      productionStderr: readFileSync('audit-production.stderr', 'utf8'),
      full: readReport('audit-full.json'),
    })
    // Never publish raw npm error headers, cookies, credentials or npmrc.
    writeFileSync('audit-gate-result.json', `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Dependency audit verification failed'
    writeFileSync('audit-gate-result.json', `${JSON.stringify({ ...outcomes, gate: 'failure', reason }, null, 2)}\n`)
    console.error(reason)
    process.exitCode = 1
  }
}
