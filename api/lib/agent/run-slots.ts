import type { Prisma } from '@prisma/client'

export const QUESTION_WAITING_ROOT_STATUS = 'waiting_question'
export const QUESTION_CLOSING_ROOT_STATUS = 'closing_question'

/** A parked question still owns its session, but uses no author execution slot. */
export const interactiveRunSlots = {
  OR: [
    { status: { in: ['queued', 'running', 'awaiting_approval'] }, taskRootId: null },
    { status: { in: ['queued', 'running', 'awaiting_approval'] },
      taskRoot: { is: { status: { notIn: [QUESTION_WAITING_ROOT_STATUS, QUESTION_CLOSING_ROOT_STATUS] } } } },
  ],
} satisfies Prisma.AgentRunWhereInput
