import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { validateCoverageBlob, validateCoverageSummary } from './lib/ci-coverage.js'

const [command, target, receiptPath, ...extra] = process.argv.slice(2)
if (command === 'blob' && target && receiptPath && !extra.length) {
  const bytes = readFileSync(target)
  const coverage = validateCoverageBlob(JSON.parse(bytes.toString('utf8')), process.cwd())
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  const blobSha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, blobSha256 }) + '\n')
  console.log(JSON.stringify({ coverageBlob: target, ...coverage, blobSha256 }))
} else if (command === 'summary' && target && !receiptPath) {
  const summary = JSON.parse(readFileSync(target, 'utf8'))
  console.log(JSON.stringify({ mergedCoverage: target, ...validateCoverageSummary(summary, process.cwd()) }))
} else throw new Error('Expected blob <file> <receipt>, or summary <file>')
