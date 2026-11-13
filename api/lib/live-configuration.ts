import type { RequestHandler, Response } from 'express'

type ConfigurationTopic = 'announcements' | 'models'
const connections = new Set<Response>()
let heartbeat: ReturnType<typeof setInterval> | undefined

function send(response: Response, frame: string) {
  // A stalled browser can reconnect and fetch the latest data. Don't queue
  // heartbeats and updates behind a blocked connection.
  if (!response.destroyed && !response.writableEnded && !response.write(frame)) response.destroy()
}

export const streamConfigurationChanges: RequestHandler = (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.once('close', () => {
    connections.delete(res)
    if (!connections.size) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
  })
  connections.add(res)
  heartbeat ??= setInterval(() => {
    for (const connection of connections) send(connection, ': keep-alive\n\n')
  }, 25_000).unref()
  send(res, 'retry: 5000\n\n')
}

/** Publish cache invalidations after the write commits. No content or user data. */
export function notifyConfigurationChange(topic: ConfigurationTopic) {
  for (const connection of connections) send(connection, `event: ${topic}\ndata: changed\n\n`)
}

export function closeConfigurationStreams() {
  const closing = [...connections]
  connections.clear()
  clearInterval(heartbeat)
  heartbeat = undefined
  for (const connection of closing) connection.end()
}
