import type { Prisma } from '@prisma/client'

/** Shared fields for the existing admin user and Credits searches. */
export function adminUserSearchWhere(search?: string): Prisma.UserWhereInput {
  const keyword = search?.trim()
  return keyword ? { OR: [
    { id: { contains: keyword, mode: 'insensitive' } },
    { nickname: { contains: keyword, mode: 'insensitive' } },
    { phone: { contains: keyword } },
    { email: { contains: keyword, mode: 'insensitive' } },
  ] } : {}
}
