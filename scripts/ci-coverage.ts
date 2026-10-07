import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateCoverageBlob, validateCoverageSummary } from './lib/ci-coverage.js'

const [command, target] = process.argv.slice(2)
if (!target || process.argv.length !== 4) throw new Error('Expected blob <file>, blobs <directory>, or summary <file>')
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
if (command === 'blob') {
  console.log(JSON.stringify({ coverageBlob: target, ...validateCoverageBlob(read(target), process.cwd()) }))
} else if (command === 'blobs') {
  const names = readdirSync(target)
  if (!names.length || names.some(name => !/^blob-\d+-\d+\.json$/u.test(name))) throw new Error('Missing or unexpected coverage blob files')
  for (const name of names) console.log(JSON.stringify({ coverageBlob: name, ...validateCoverageBlob(read(resolve(target, name)), process.cwd()) }))
} else if (command === 'summary') {
  console.log(JSON.stringify({ mergedCoverage: target, ...validateCoverageSummary(read(target), process.cwd()) }))
} else throw new Error('Expected blob, blobs, or summary')
