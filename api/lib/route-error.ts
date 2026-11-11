import type { Response } from 'express'

import { buildError } from './http.js'
import { DataAccessError, normalizeDataAccessError } from './prisma.js'

export function sendRouteError(res: Response, requestId: string, error: unknown): void {
  if (error instanceof DataAccessError) {
    res.status(error.status).json(buildError(requestId, error.code, error.message, error.fieldErrors))
    return
  }

  const normalizedError = normalizeDataAccessError(error, 'route')
  if (normalizedError.code !== 'DATA_ACCESS_ERROR') {
    res
      .status(normalizedError.status)
      .json(buildError(requestId, normalizedError.code, normalizedError.message))
    return
  }

  console.error(error)
  res.status(500).json(buildError(requestId, 'INTERNAL_SERVER_ERROR', '服务暂时不可用，请稍后重试。'))
}
