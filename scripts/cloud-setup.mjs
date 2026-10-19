import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function assertCloudRuntime(nodeVersion, npmVersion, pinnedNode, engines) {
  if (nodeVersion !== pinnedNode || nodeVersion !== engines.node || npmVersion !== engines.npm) {
    throw new Error(`Use repository Node ${pinnedNode} and npm ${engines.npm} (found Node ${nodeVersion}, npm ${npmVersion}); setup does not upgrade runtimes or lockfiles`)
  }
}
export function cloudNpmCommand(args) {
  // Prefer npm bundled with this Node, including portable Windows installs
  // without .cmd shims. Only fixed arguments are passed to the fallback shim.
  const bundled = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (existsSync(bundled)) return { program: process.execPath, args: [bundled, ...args], shell: false }
  return { program: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, shell: process.platform === 'win32' }
}
function npm(args) {
  const command = cloudNpmCommand(args)
  return execFileSync(command.program, command.args,
    { cwd: root, shell: command.shell, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}
function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--install')) throw new Error('Usage: node scripts/cloud-setup.mjs [--install]')
  const engines = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).engines
  const pinnedNode = readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  assertCloudRuntime(process.versions.node, npm(['--version']).trim(), pinnedNode, engines)
  if (args[0] === '--install') {
    npm(['ci'])
    npm(['run', 'runtime:verify'])
    npm(['exec', '--no', '--', 'prisma', 'generate'])
    console.log('Locked dependencies and Prisma Client are ready. No database provisioning or migrations were executed.')
  } else console.log('Pinned Node/npm match. Run with --install to install locked dependencies and generate Prisma Client.')
  console.log('Full tests require an explicitly configured isolated PostgreSQL database and TEST_DATABASE_REQUIRED=true; use the original exact-SHA CI for release evidence.')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
