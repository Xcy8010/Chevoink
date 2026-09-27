import { Prisma, PrismaClient } from '@prisma/client'
import { withGoalDatabaseFences } from './agent/goal-database.js'
// Resolve the application's selected environment before deriving pool options.
import '../config/env.js'

declare global {
   
  var __chevoinkPrisma__: PrismaClient | undefined
}

/** Prisma maps timestamp-without-time-zone to UTC. PostgreSQL defaults such as
 * CURRENT_TIMESTAMP must use the same clock representation on every pooled
 * connection, regardless of the host/database timezone. Preserve other options. */
export function databaseUrlWithUtcSession(value: string | undefined): string | undefined {
  if (!value) return value
  try {
    const url = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return value
    const options = url.searchParams.get('options')?.trim()
    url.searchParams.set('options', [options, '-c timezone=UTC'].filter(Boolean).join(' '))
    return url.toString()
  } catch {
    // Keep Prisma's original configuration diagnostics, without logging secrets.
    return value
  }
}

const prismaClient =
  globalThis.__chevoinkPrisma__ ??
  new PrismaClient({
    log: ['error'],
    datasourceUrl: databaseUrlWithUtcSession(process.env.DATABASE_URL),
  })

if (process.env.NODE_ENV !== 'production') {
  globalThis.__chevoinkPrisma__ = prismaClient
}

export const prisma = withGoalDatabaseFences(prismaClient)

export class DataAccessError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'DataAccessError'
    this.status = status
    this.code = code
  }
}

function isDatabaseConfigError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientInitializationError &&
    /Environment variable not found:\s*DATABASE_URL/i.test(error.message)
  )
}

function isConnectivityError(error: unknown): boolean {
  if (isDatabaseConfigError(error)) {
    return false
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return ['P1000', 'P1001', 'P1002', 'P1008', 'P1017'].includes(error.code)
  }

  return false
}

export function normalizeDataAccessError(error: unknown, label: string): DataAccessError {
  if (error instanceof DataAccessError) {
    return error
  }

  if (isDatabaseConfigError(error)) {
    return new DataAccessError(
      500,
      'DATABASE_NOT_CONFIGURED',
      '本地数据库尚未配置，当前操作无法连接数据源。',
    )
  }

  if (isConnectivityError(error)) {
    return new DataAccessError(
      503,
      'DATABASE_UNAVAILABLE',
      '数据库暂时不可用，请稍后再试。',
    )
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return new DataAccessError(500, `PRISMA_${error.code}`, `${label} 失败`)
  }

  if (error instanceof Error) {
    return new DataAccessError(500, 'DATA_ACCESS_ERROR', error.message)
  }

  return new DataAccessError(500, 'DATA_ACCESS_ERROR', `${label} 失败`)
}
