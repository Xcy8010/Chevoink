import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function assertReleaseCi(ci, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision) || ci.headSha !== revision || ci.workflowName !== 'CI'
    || ci.status !== 'completed' || ci.conclusion !== 'success') throw new Error('CI identity or outcome mismatch')
  if (!Array.isArray(ci.jobs) || ci.jobs.some(job => job.status !== 'completed' || job.conclusion !== 'success')) {
    throw new Error('Every CI job must complete successfully')
  }
  const names = ci.jobs.map(job => job.name)
  const required = ['plan test shards', 'check / lint / build / audit', 'merge coverage / test report', 'check / lint / test / build / audit']
  for (const name of required) if (names.filter(value => value === name).length !== 1) throw new Error('Missing or duplicate CI gate: ' + name)
  const shards = names.filter(name => /^test shard \d+\/\d+$/.test(name))
  const count = Number(shards[0]?.split('/')[1])
  if (!Number.isInteger(count) || count < 1 || count !== shards.length) throw new Error('Incomplete test shard set')
  for (let index = 1; index <= count; index++) {
    if (shards.filter(name => name === `test shard ${index}/${count}`).length !== 1) throw new Error('Invalid test shard set')
  }
  if (names.length !== required.length + count) throw new Error('Unexpected CI job set')
  return { revision, testShards: count }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: release-ci.mjs SHA CI_JSON_FILE')
  console.log(JSON.stringify(assertReleaseCi(JSON.parse(readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, '')), process.argv[2])))
}
