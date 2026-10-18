import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { readDaemonIdentity, readMonitor, encodeMonitorRequest, decodeMonitorReply, snapshotProductionProcess, verifyApiProcess } from '../../scripts/production-process-snapshot.mjs'

const executable = '/opt/chevoink/runtime/node-v22.23.2-linux-x64/bin/node'
function fixture() {
  const files = new Map<string, string>(), links = new Map<string, string>()
  const metadata = (kind: string, mode: number, ino: number) => ({ uid: 1000, mode, ino, dev: 1,
    isDirectory: () => kind === 'directory', isFile: () => kind === 'file', isSocket: () => kind === 'socket' })
  const stats = new Map([
    ['/home/ubuntu', metadata('directory', 0o755, 1)], ['/home/ubuntu/.pm2', metadata('directory', 0o755, 2)],
    ['/home/ubuntu/.pm2/pm2.pid', metadata('file', 0o600, 3)], ['/home/ubuntu/.pm2/rpc.sock', metadata('socket', 0o775, 4)],
  ])
  function addProcess(pid: number, parent: number) {
    files.set(`/proc/${pid}/status`, `State:\tS (sleeping)\nPPid:\t${parent}\nUid:\t1000\t1000\t1000\t1000\n`)
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[19] = String(pid * 10)
    files.set(`/proc/${pid}/stat`, `${pid} (node) ${fields.join(' ')}`)
    links.set(`/proc/${pid}/exe`, executable)
  }
  addProcess(20, 1); addProcess(30, 20)
  files.set('/home/ubuntu/.pm2/pm2.pid', '20\n')
  files.set('/proc/20/cmdline', 'PM2 v7.0.3: God Daemon (/home/ubuntu/.pm2)\0')
  files.set('/proc/net/unix', 'Num RefCount Protocol Flags Type St Inode Path\n0: 00000002 00000000 00010000 0001 01 900 /home/ubuntu/.pm2/rpc.sock\n')
  links.set('/proc/20/fd/7', 'socket:[900]'); links.set('/proc/30/cwd', '/opt/chevoink/app/current')
  const io = {
    readFileSync(filename: string) { const value = files.get(filename); if (value === undefined) throw new Error('missing fixture'); return Buffer.from(value) },
    lstatSync(filename: string) { const value = stats.get(filename); if (!value) throw new Error('missing stat'); return value },
    realpathSync(filename: string) { return links.get(filename) ?? filename },
    readdirSync() { return ['7'] },
    readlinkSync(filename: string) { return links.get(filename) },
  }
  const options = { env: { HOME: '/home/ubuntu', CHEVOINK_NODE_BINARY: executable }, runtime: '22.23.2', uid: 1000,
    account: { username: 'ubuntu', homedir: '/home/ubuntu', uid: 1000 }, io }
  const processes = [{ name: 'chevoink-api', pm_id: 0, pid: 30,
    pm2_env: { status: 'online', pm_cwd: '/opt/chevoink/app/current', pm_exec_path: '/opt/chevoink/app/current/api/server.ts', pm_uptime: 123456 } }]
  return { files, links, stats, options, io, processes }
}
function encodeReply(reply: object, id: string) {
  const parts = [Buffer.from([0x12])]
  for (const text of ['j:' + JSON.stringify(reply), 's:' + id]) {
    const bytes = Buffer.from(text), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); parts.push(length, bytes)
  }
  return Buffer.concat(parts)
}
class FakeSocket extends EventEmitter {
  destroyed = false
  writes = 0
  constructor(private answer: (request: Buffer, socket: FakeSocket) => void) { super() }
  write(value: Buffer) { this.writes++; this.answer(value, this) }
  destroy() { this.destroyed = true; this.emit('close') }
}
function requestParts(bytes: Buffer) {
  expect(bytes[0]).toBe(0x12)
  const length = bytes.readUInt32BE(1), message = JSON.parse(bytes.subarray(7, 5 + length).toString())
  const start = 5 + length, idLength = bytes.readUInt32BE(start)
  const id = bytes.subarray(start + 6, start + 4 + idLength).toString()
  expect(message).toEqual({ type: 'call', method: 'getMonitorData', args: [{}] })
  return id
}
describe('production read-only process snapshot', () => {
  it('verifies Ubuntu, daemon ownership/runtime/command and the daemon-owned listening socket', () => {
    const f = fixture(), identity = readDaemonIdentity(f.options)
    expect(identity).toMatchObject({ pid: 20, start: '200', listener: '900', socketInode: 4, uid: 1000 })
    expect(verifyApiProcess(f.processes, identity, f.io)).toEqual({ pid: 30, start: 123456, daemonPid: 20, daemonStart: '200' })
  })
  it.each(['home', 'pm2-home', 'user', 'uid', 'missing-daemon', 'zombie', 'daemon-runtime', 'daemon-title', 'socket-type', 'socket-owner', 'pid-owner', 'socket-listener', 'socket-fd'])(
    'rejects %s without performing RPC or spawning anything', async scenario => {
      const f = fixture()
      if (scenario === 'home') f.options.env.HOME = '/root'
      if (scenario === 'pm2-home') Object.assign(f.options.env, { PM2_HOME: '/tmp/pm2' })
      if (scenario === 'user') f.options.account.username = 'root'
      if (scenario === 'uid') f.options.uid = 0
      if (scenario === 'missing-daemon') f.files.delete('/proc/20/status')
      if (scenario === 'zombie') f.files.set('/proc/20/status', f.files.get('/proc/20/status')!.replace('S (sleeping)', 'Z (zombie)'))
      if (scenario === 'daemon-runtime') f.links.set('/proc/20/exe', '/usr/bin/node')
      if (scenario === 'daemon-title') f.files.set('/proc/20/cmdline', 'unrelated daemon\0')
      if (scenario === 'socket-type') f.stats.get('/home/ubuntu/.pm2/rpc.sock')!.isSocket = () => false
      if (scenario === 'socket-owner') f.stats.get('/home/ubuntu/.pm2/rpc.sock')!.uid = 0
      if (scenario === 'pid-owner') f.stats.get('/home/ubuntu/.pm2/pm2.pid')!.uid = 0
      if (scenario === 'socket-listener') f.files.set('/proc/net/unix', '')
      if (scenario === 'socket-fd') f.links.set('/proc/20/fd/7', 'socket:[901]')
      let calls = 0
      await expect(snapshotProductionProcess({ identity: () => readDaemonIdentity(f.options), monitor: async () => { calls++; return f.processes }, io: f.io })).rejects.toThrow()
      expect(calls).toBe(0)
    })
  it.each(['pm-id', 'status', 'path', 'cwd', 'parent', 'runtime', 'owner', 'duplicate'])(
    'rejects invalid API %s after the read-only response', scenario => {
      const f = fixture(), daemon = readDaemonIdentity(f.options)
      if (scenario === 'pm-id') f.processes[0].pm_id = 1
      if (scenario === 'status') f.processes[0].pm2_env.status = 'stopped'
      if (scenario === 'path') f.processes[0].pm2_env.pm_exec_path = '/tmp/server.ts'
      if (scenario === 'cwd') f.links.set('/proc/30/cwd', '/tmp/other')
      if (scenario === 'parent') f.files.set('/proc/30/status', f.files.get('/proc/30/status')!.replace('PPid:\t20', 'PPid:\t21'))
      if (scenario === 'runtime') f.links.set('/proc/30/exe', '/usr/bin/node')
      if (scenario === 'owner') f.files.set('/proc/30/status', f.files.get('/proc/30/status')!.replace('1000\t1000', '0\t0'))
      if (scenario === 'duplicate') f.processes.push(f.processes[0])
      expect(() => verifyApiProcess(f.processes, daemon, f.io)).toThrow()
    })
  it('rejects daemon PID/start/socket replacement between identity checks', async () => {
    for (const key of ['pid', 'start', 'socketInode', 'listener']) {
      const f = fixture(), before = readDaemonIdentity(f.options); let reads = 0
      await expect(snapshotProductionProcess({ identity: () => reads++ ? { ...before, [key]: 'changed' } : before,
        monitor: async () => f.processes, io: f.io })).rejects.toThrow('Daemon identity changed')
    }
  })
  it('sends only getMonitorData once and accepts fragmented correlated AMP 1 replies', async () => {
    const f = fixture(), identity = readDaemonIdentity(f.options)
    const socket = new FakeSocket((request, target) => {
      const id = requestParts(request), reply = encodeReply({ args: [f.processes] }, id)
      target.emit('data', reply.subarray(0, 3)); target.emit('data', reply.subarray(3))
    })
    const connect = (options: { path: string }) => { expect(options.path).toBe('/home/ubuntu/.pm2/rpc.sock'); queueMicrotask(() => socket.emit('connect')); return socket }
    expect(await readMonitor(identity, { connect })).toEqual(f.processes)
    expect(socket.writes).toBe(1); expect(socket.destroyed).toBe(true)
    expect(requestParts(encodeMonitorRequest('test-id'))).toBe('test-id')
  })
  it.each(['timeout', 'disconnect', 'error', 'wrong-id', 'rpc-error', 'oversize', 'malformed'])(
    'fails closed on RPC %s with no retry', async scenario => {
      const f = fixture(), socket = new FakeSocket((request, target) => {
        const id = requestParts(request)
        if (scenario === 'disconnect') target.emit('end')
        if (scenario === 'error') target.emit('error', new Error('refused'))
        if (scenario === 'wrong-id') target.emit('data', encodeReply({ args: [[]] }, id + '-other'))
        if (scenario === 'rpc-error') target.emit('data', encodeReply({ error: 'private remote diagnostic' }, id))
        if (scenario === 'oversize') { const bytes = Buffer.from([0x12, 0, 0, 0, 0]); bytes.writeUInt32BE(9 * 1024 * 1024, 1); target.emit('data', bytes) }
        if (scenario === 'malformed') target.emit('data', Buffer.from('unexpected CLI output'))
      })
      let connects = 0
      await expect(readMonitor(readDaemonIdentity(f.options), { timeoutMs: 10, connect: () => { connects++; queueMicrotask(() => socket.emit('connect')); return socket } })).rejects.toThrow('no daemon was started')
      expect(connects).toBe(1); expect(socket.writes).toBe(1); expect(socket.destroyed).toBe(true)
    })
  it('rejects extra frames and does not expose RPC error payloads', () => {
    expect(() => decodeMonitorReply(Buffer.concat([encodeReply({ args: [[]] }, 'id'), Buffer.from([0])]), 'id')).toThrow()
    expect(() => decodeMonitorReply(encodeReply({ error: 'secret-value' }, 'id'), 'id')).toThrow('RPC monitor response rejected')
  })
})
