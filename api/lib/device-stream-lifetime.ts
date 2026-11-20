import type { RequestHandler, Response } from 'express'

import { getSessionUserId, isDeviceSessionActive, requireDeviceIdentity } from './auth-session.js'

type StreamGroup = { responses: Set<Response>; timer: NodeJS.Timeout }
const streams = new Map<string, StreamGroup>()

/** Long-lived private streams outlive their opening HTTP request's session check. */
export const guardDeviceStreams: RequestHandler = (req, res, next) => {
  if (!getSessionUserId(req)) { next(); return }
  const identity = requireDeviceIdentity(req)
  const key = JSON.stringify([identity.userId, identity.deviceId, identity.tokenVersion])
  let group = streams.get(key)
  if (!group) {
    const responses = new Set<Response>()
    let checking = false
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        if (!await isDeviceSessionActive(identity)) {
          for (const response of responses) response.destroy()
        }
      } catch {
        for (const response of responses) response.destroy()
      } finally {
        checking = false
      }
    }, 15_000)
    timer.unref()
    group = { responses, timer }
    streams.set(key, group)
  }
  const active = group
  active.responses.add(res)
  res.once('close', () => {
    active.responses.delete(res)
    if (!active.responses.size) {
      clearInterval(active.timer)
      streams.delete(key)
    }
  })
  next()
}
