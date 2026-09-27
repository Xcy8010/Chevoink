import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma } from '@prisma/client'

/** Server-only identity. Never deserialize this from a model/tool/client payload. */
export interface GoalExecutionContext {
  goalId: string; revision: number; epoch: bigint; userId: string; novelId: string; sessionId: string; runId: string
}
const execution = new AsyncLocalStorage<GoalExecutionContext>()
const effects = new AsyncLocalStorage<boolean>()
const transaction = new AsyncLocalStorage<Prisma.TransactionClient>()
export const currentGoalExecution = () => execution.getStore()
export const currentGoalEffectScope = () => effects.getStore() === true ? execution.getStore() : undefined
export const currentGoalTransaction = () => transaction.getStore()
export const withGoalTransaction = <T>(tx: Prisma.TransactionClient, work: () => T): T => transaction.run(tx, work)
export const withGoalExecutionContext = <T>(context: GoalExecutionContext | undefined, work: () => T): T =>
  context ? execution.run(context, work) : work()
export const withGoalEffects = <T>(work: () => T): T => effects.run(true, work)
/** Receipts/settlement must survive cancellation; this does NOT permit another provider dispatch. */
export const withoutGoalEffects = <T>(work: () => T): T => effects.run(false, work)
