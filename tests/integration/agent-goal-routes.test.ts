import { randomUUID } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingMessage, type Server } from 'node:http'

import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { env } from '../../api/config/env.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { prisma } from '../../api/lib/prisma.js'
import type { AgentGoalSnapshot } from '../../shared/contracts/agent-goal.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const previousGoalEnabled = env.agentGoalEnabled

type Scope = { userId: string; novelId: string; sessionId: string; secondSessionId: string }
type RouteFixture = { owner: Scope; other: Scope }

const fixtures: string[] = []
const activeStreams = new Set<OpenSse>()
let httpServer: Server | null = null

function cookie(userId: string) {
  return `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`
}

async function listen(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
}

async function createScope(label: string): Promise<Scope> {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), secondSessionId = randomUUID()
  await prisma.user.create({ data: { id: userId, nickname: `goal-route-${label}-${randomUUID()}`, passwordHash: 'fixture-only' } })
  await prisma.novel.create({ data: { id: novelId, authorId: userId, title: `目标路由${label}`, slug: randomUUID(), summary: '' } })
  await prisma.agentSession.createMany({ data: [
    { id: sessionId, userId, novelId, title: `目标路由${label} A` },
    { id: secondSessionId, userId, novelId, title: `目标路由${label} B` },
  ] })
  fixtures.push(userId)
  return { userId, novelId, sessionId, secondSessionId }
}

async function createFixture(): Promise<RouteFixture> {
  return { owner: await createScope('owner'), other: await createScope('other') }
}

async function cleanupUser(userId: string) {
  await prisma.agentGoal.deleteMany({ where: { userId } })
  await prisma.agentGoalCommand.deleteMany({ where: { userId } })
  await prisma.agentSession.deleteMany({ where: { userId } })
  await prisma.novel.deleteMany({ where: { authorId: userId } })
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
}

function goalInput(requestId = randomUUID(), objective = '完成 HTTP 目标路由验收') {
  return { requestId, objective, options: { mode: 'build' as const } }
}

async function createGoal(scope: Scope, body = goalInput()): Promise<AgentGoalSnapshot> {
  const response = await request(app)
    .post(`/api/agent/sessions/${scope.sessionId}/goals`)
    .set('Cookie', cookie(scope.userId))
    .send(body)
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ success: true })
  return response.body.data as AgentGoalSnapshot
}

type Waiter = {
  predicate: (body: string) => boolean
  resolve: (body: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type OpenSse = {
  request: ClientRequest
  response: IncomingMessage
  body: () => string
  waitFor: (predicate: (body: string) => boolean, timeoutMs?: number) => Promise<string>
  closed: Promise<void>
}

/** Connect through a real HTTP listener and stop after the initial snapshot. */
async function openGoalEvents(scope: Scope): Promise<OpenSse> {
  if (!httpServer) throw new Error('test HTTP server is not ready')
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('test HTTP server has no TCP address')

  return new Promise((resolve, reject) => {
    let settled = false
    const client = httpRequest({
      hostname: '127.0.0.1', port: address.port,
      path: `/api/agent/sessions/${scope.sessionId}/goal-events`, method: 'GET',
      headers: { Accept: 'text/event-stream', Cookie: cookie(scope.userId) },
    })
    client.once('error', error => { if (!settled) reject(error) })
    client.once('response', response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`goal event stream returned ${response.statusCode}`))
        return
      }
      response.setEncoding('utf8')
      let body = ''
      let resolveClosed: () => void = () => {}
      const closed = new Promise<void>(resolveClose => { resolveClosed = resolveClose })
      const waiters = new Set<Waiter>()
      const failWaiters = () => {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error('goal event stream closed before the expected event'))
        }
        waiters.clear()
      }
      const checkWaiters = () => {
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(body)) continue
          waiters.delete(waiter)
          clearTimeout(waiter.timer)
          waiter.resolve(body)
        }
      }
      const close = () => { failWaiters(); resolveClosed() }
      response.once('close', close)
      response.once('end', close)
      client.once('close', close)
      response.on('data', chunk => {
        body += chunk
        checkWaiters()
        if (!settled && body.includes('event: snapshot')) {
          settled = true
          resolve({
            request: client,
            response,
            body: () => body,
            waitFor: (predicate, timeoutMs = 5_000) => {
              if (predicate(body)) return Promise.resolve(body)
              return new Promise<string>((resolveWait, rejectWait) => {
                const waiter: Waiter = {
                  predicate, resolve: resolveWait, reject: rejectWait,
                  timer: setTimeout(() => { waiters.delete(waiter); rejectWait(new Error('timed out waiting for goal event')) }, timeoutMs),
                }
                waiters.add(waiter)
              })
            },
            closed,
          })
        }
      })
    })
    client.end()
  })
}

describe.skipIf(!dbAvailable)('agent goal HTTP routes (isolated test DB)', () => {
  beforeAll(async () => {
    env.agentGoalEnabled = true
    httpServer = await listen()
  })

  afterEach(async () => {
    for (const stream of activeStreams) stream.request.destroy()
    await Promise.allSettled([...activeStreams].map(stream => stream.closed))
    activeStreams.clear()
    while (fixtures.length) await cleanupUser(fixtures.pop()!)
  })

  afterAll(async () => {
    env.agentGoalEnabled = previousGoalEnabled
    await new Promise<void>(resolve => httpServer?.close(() => resolve()) ?? resolve())
    httpServer = null
    await prisma.$disconnect()
  })

  it('requires real authentication before validating the goal body', async () => {
    const fixture = await createFixture()
    const response = await request(app)
      .post(`/api/agent/sessions/${fixture.owner.sessionId}/goals`)
      .send({ malformed: true })

    expect(response.status).toBe(401)
    expect(response.body.error).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(await prisma.agentGoal.count({ where: { userId: fixture.owner.userId } })).toBe(0)
  })

  it('returns 404 for another user and another session without revealing a goal', async () => {
    const fixture = await createFixture()
    const goal = await createGoal(fixture.owner)

    const otherUser = await request(app)
      .get(`/api/agent/sessions/${fixture.owner.sessionId}/goals/${goal.id}`)
      .set('Cookie', cookie(fixture.other.userId))
    expect(otherUser.status).toBe(404)
    expect(otherUser.body.error).toMatchObject({ code: 'NOT_FOUND' })

    const otherSession = await request(app)
      .get(`/api/agent/sessions/${fixture.owner.secondSessionId}/goals/${goal.id}`)
      .set('Cookie', cookie(fixture.owner.userId))
    expect(otherSession.status).toBe(404)
    expect(otherSession.body.error).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('replays duplicate create request IDs exactly once', async () => {
    const fixture = await createFixture()
    const body = goalInput()
    const first = await request(app)
      .post(`/api/agent/sessions/${fixture.owner.sessionId}/goals`)
      .set('Cookie', cookie(fixture.owner.userId)).send(body)
    const second = await request(app)
      .post(`/api/agent/sessions/${fixture.owner.sessionId}/goals`)
      .set('Cookie', cookie(fixture.owner.userId)).send(body)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.data).toEqual(first.body.data)
    expect(await prisma.agentGoal.count({ where: { sessionId: fixture.owner.sessionId } })).toBe(1)
    expect(await prisma.agentGoalCommand.count({ where: { userId: fixture.owner.userId, requestId: body.requestId } })).toBe(1)
  })

  it('creates a new local session and goal atomically without dispatching a run', async () => {
    const fixture = await createFixture()
    const sessionsBefore = await prisma.agentSession.count({ where: { novelId: fixture.owner.novelId } })
    const response = await request(app)
      .post('/api/agent/goals')
      .set('Cookie', cookie(fixture.owner.userId))
      .send({ novelId: fixture.owner.novelId, ...goalInput() })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ success: true, data: { novelId: fixture.owner.novelId } })
    const sessionId = response.body.data.sessionId as string
    expect(sessionId).not.toBe(fixture.owner.sessionId)
    expect(await prisma.agentSession.count({ where: { novelId: fixture.owner.novelId } })).toBe(sessionsBefore + 1)
    expect(await prisma.agentGoal.count({ where: { sessionId } })).toBe(1)
    expect(await prisma.agentRun.count({ where: { sessionId } })).toBe(0)
  })

  it('streams only the authenticated session snapshot/events and closes cleanly on disconnect', async () => {
    const fixture = await createFixture()
    const ownerGoal = await createGoal(fixture.owner)
    const otherGoal = await createGoal(fixture.other)
    const stream = await openGoalEvents(fixture.owner)
    activeStreams.add(stream)

    expect(stream.body()).toContain('event: snapshot')
    expect(stream.body()).toContain(ownerGoal.id)
    expect(stream.body()).not.toContain(otherGoal.id)
    expect(stream.body()).not.toContain(fixture.other.sessionId)

    const paused = await request(app)
      .post(`/api/agent/sessions/${fixture.owner.sessionId}/goals/${ownerGoal.id}/actions`)
      .set('Cookie', cookie(fixture.owner.userId))
      .send({ requestId: randomUUID(), expectedStateVersion: ownerGoal.stateVersion, action: 'pause' })
    expect(paused.status).toBe(200)
    await stream.waitFor(body => body.includes(`"goalId":"${ownerGoal.id}"`) && body.includes('"status":"paused"'))
    expect(stream.body()).not.toContain(otherGoal.id)
    expect(stream.body()).not.toContain(fixture.other.sessionId)

    stream.request.destroy()
    await stream.closed
    expect(stream.response.destroyed || stream.response.complete).toBe(true)
  })
})
