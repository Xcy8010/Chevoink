import * as fs from 'node:fs'
import net from 'node:net'
import { userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const home = '/home/ubuntu', pm2Home = home + '/.pm2', socketPath = pm2Home + '/rpc.sock'
const maxReply = 8 * 1024 * 1024
const fail = message => { throw new Error(message) }
function bounded(io, filename, max = 65536) {
  const value = io.readFileSync(filename)
  if (value.length > max) fail('Process identity evidence exceeds limit')
  return value.toString('utf8')
}
function processIdentity(io, pid, uid, executable) {
  if (!Number.isSafeInteger(pid) || pid < 2) fail('Invalid process PID')
  const status = bounded(io, `/proc/${pid}/status`)
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status)
  if (!uids || uids.slice(1).some(value => Number(value) !== uid) || !/^State:\s+[RSDI]/m.test(status)) fail('Process owner or live state mismatch')
  if (io.realpathSync(`/proc/${pid}/exe`) !== executable) fail('Process runtime mismatch')
  const stat = bounded(io, `/proc/${pid}/stat`), fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (!/^\d+$/.test(fields[19] ?? '')) fail('Process start identity is unavailable')
  return { pid, start: fields[19], ppid: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]) }
}

/** No PM2 import or CLI: even stale sockets can never cause daemon startup. */
export function readDaemonIdentity({ env = process.env, runtime = process.versions.node,
  uid = process.getuid?.(), account = userInfo(), io = fs } = {}) {
  const executable = `/opt/chevoink/runtime/node-v${runtime}-linux-x64/bin/node`
  if (uid !== 1000 || account.username !== 'ubuntu' || account.homedir !== home || account.uid !== uid
    || env.HOME !== home || env.PM2_HOME !== undefined && env.PM2_HOME !== pm2Home
    || env.CHEVOINK_NODE_BINARY !== executable) fail('Production user, home or runtime mismatch')
  for (const directory of [home, pm2Home]) {
    const stat = io.lstatSync(directory)
    if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 2 || io.realpathSync(directory) !== directory) fail('PM2 home identity mismatch')
  }
  const pidFile = io.lstatSync(pm2Home + '/pm2.pid'), socket = io.lstatSync(socketPath)
  if (!pidFile.isFile() || pidFile.uid !== uid || pidFile.mode & 0o022 || !socket.isSocket() || socket.uid !== uid || socket.mode & 2) fail('PM2 PID file or socket identity mismatch')
  const pidText = bounded(io, pm2Home + '/pm2.pid', 64).trim()
  if (!/^[1-9]\d*$/.test(pidText)) fail('Invalid daemon PID file')
  const daemon = processIdentity(io, Number(pidText), uid, executable)
  if (bounded(io, `/proc/${daemon.pid}/cmdline`, 16384).replace(/\0+$/, '') !== `PM2 v7.0.3: God Daemon (${pm2Home})`) fail('Daemon command identity mismatch')
  const listeners = bounded(io, '/proc/net/unix', maxReply).split('\n').map(line => line.trim().split(/\s+/))
    .filter(fields => fields[7] === socketPath && fields[3] === '00010000' && fields[4] === '0001' && fields[5] === '01')
  if (listeners.length !== 1 || !/^\d+$/.test(listeners[0][6])) fail('Daemon listening socket is unavailable')
  const descriptorNames = io.readdirSync(`/proc/${daemon.pid}/fd`)
  if (descriptorNames.length > 4096 || !descriptorNames.some(name => {
    try { return io.readlinkSync(`/proc/${daemon.pid}/fd/${name}`) === `socket:[${listeners[0][6]}]` } catch { return false }
  })) fail('RPC listener is not owned by the verified daemon')
  return { ...daemon, uid, executable, socketPath, listener: listeners[0][6],
    socketDevice: socket.dev, socketInode: socket.ino, pidDevice: pidFile.dev, pidInode: pidFile.ino }
}

// PM2 7.0.3's bundled pm2-axon-rpc / amp-message: AMP v1, two
// length-prefixed arguments (j: RPC object, s: correlation ID).
export function encodeMonitorRequest(id) {
  const values = [Buffer.from('j:' + JSON.stringify({ type: 'call', method: 'getMonitorData', args: [{}] })), Buffer.from('s:' + id)]
  const parts = [Buffer.from([0x12])]
  for (const value of values) { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); parts.push(length, value) }
  return Buffer.concat(parts)
}
export function decodeMonitorReply(bytes, id) {
  if (bytes.length > maxReply) fail('RPC response exceeds limit')
  if (!bytes.length) return null
  if (bytes[0] !== 0x12) fail('Invalid RPC framing')
  let offset = 1; const values = []
  for (let index = 0; index < 2; index++) {
    if (bytes.length < offset + 4) return null
    const length = bytes.readUInt32BE(offset); offset += 4
    if (length > maxReply || offset + length > maxReply) fail('RPC argument exceeds limit')
    if (bytes.length < offset + length) return null
    values.push(bytes.subarray(offset, offset + length).toString('utf8')); offset += length
  }
  if (offset !== bytes.length || values[1] !== 's:' + id || !values[0].startsWith('j:')) fail('RPC reply identity mismatch')
  const reply = JSON.parse(values[0].slice(2))
  if (reply === null || typeof reply !== 'object' || 'error' in reply || !Array.isArray(reply.args)
    || reply.args.length !== 1 || !Array.isArray(reply.args[0]) || reply.args[0].length > 128) fail('RPC monitor response rejected')
  return reply.args[0]
}
export function readMonitor(identity, { connect = options => net.createConnection(options), timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = 'chevoink-readonly:' + randomUUID()
    let socket, bytes = Buffer.alloc(0), settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); socket?.destroy()
      if (error) reject(new Error('PM2 read-only RPC failed; no daemon was started'))
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('RPC timeout')), timeoutMs)
    try {
      socket = connect({ path: identity.socketPath })
      socket.once('connect', () => { try { socket.write(encodeMonitorRequest(id)) } catch (error) { finish(error) } })
      socket.on('data', value => {
        try {
          if (bytes.length + value.length > maxReply) fail('RPC response exceeds limit')
          bytes = Buffer.concat([bytes, value]); const result = decodeMonitorReply(bytes, id)
          if (result !== null) finish(null, result)
        } catch (error) { finish(error) }
      })
      socket.once('error', error => finish(error)); socket.once('end', () => finish(new Error('RPC disconnected')))
      socket.once('close', () => finish(new Error('RPC closed')))
    } catch (error) { finish(error) }
  })
}
export function verifyApiProcess(processes, daemon, io = fs) {
  const matches = processes.filter(value => value?.name === 'chevoink-api'), api = matches[0], env = api?.pm2_env
  if (matches.length !== 1 || api.pm_id !== 0 || env?.status !== 'online' || env.pm_cwd !== '/opt/chevoink/app/current'
    || env.pm_exec_path !== '/opt/chevoink/app/current/api/server.ts' || !Number.isSafeInteger(env.pm_uptime) || env.pm_uptime < 1) fail('API identity mismatch')
  const actual = processIdentity(io, api.pid, daemon.uid, daemon.executable)
  if (actual.ppid !== daemon.pid || io.realpathSync(`/proc/${api.pid}/cwd`) !== '/opt/chevoink/app/current') fail('API parent or working directory mismatch')
  return { pid: api.pid, start: env.pm_uptime, daemonPid: daemon.pid, daemonStart: daemon.start }
}
export async function snapshotProductionProcess({ identity = () => readDaemonIdentity(), monitor = value => readMonitor(value), io = fs } = {}) {
  const before = identity(), processes = await monitor(before), after = identity()
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('Daemon identity changed during RPC')
  return verifyApiProcess(processes, after, io)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux') fail('Production snapshot requires Linux')
    console.log(JSON.stringify(await snapshotProductionProcess()))
  } catch { console.error('Production process identity or read-only RPC failed; no daemon was started. Inspect actual state.'); process.exitCode = 1 }
}
