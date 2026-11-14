import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  agentPersonalizationRevisionSchema,
  agentPersonalizationExpectedRevisionSchema,
  agentPersonalizationMemoryIdSchema,
  agentPersonalizationRuleNameSchema,
  createAgentPersonalizationMemorySchema,
  patchAgentPersonalizationMemorySchema,
  patchAgentPersonalizationSchema,
  writeAgentPersonalizationRuleSchema,
} from '../../shared/contracts/agent-personalization.js'
import {
  changePersonalizationRule,
  clearPersonalizationMemories,
  createPersonalizationMemory,
  deletePersonalizationMemory,
  getAgentPersonalization,
  listPersonalizationMemories,
  patchAgentPersonalization,
  restorePersonalizationMemory,
  updatePersonalizationMemory,
} from '../lib/agent/personalization.js'
import { assertPersonalizationRuleOperation, listPersonalizationRuleOperations } from '../lib/agent/personalization-tool-policy.js'
import { hasAgentPersonalizationCapability } from '../lib/app-releases.js'
import { requireSessionUserId } from '../lib/auth-session.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { DataAccessError } from '../lib/prisma.js'
import { sendRouteError } from '../lib/route-error.js'

const router = Router()
const settingsPath = '/personalization'
const memoriesPath = '/personalization/memories'
const memoryPath = '/personalization/memories/:memoryId'
const deleteRevisionSchema = z.object({
  expectedRevision: z.string().regex(/^\d+$/u).transform(Number).pipe(agentPersonalizationRevisionSchema),
}).strict()

async function requirePersonalizationUser(req: Request): Promise<string> {
  const userId = requireSessionUserId(req)
  if (!await hasAgentPersonalizationCapability(userId)) {
    throw new DataAccessError(403, 'APP_RELEASE_CAPABILITY_DISABLED', '当前应用版本尚未开放此功能。')
  }
  return userId
}

router.get(settingsPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await getAgentPersonalization(userId)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.patch(settingsPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const body = parseBody(patchAgentPersonalizationSchema, req.body, '个性化设置参数无效。')
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await patchAgentPersonalization(userId, body)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.get(memoriesPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    res.setHeader('Cache-Control', 'no-store')
    const { memories, archived, revision } = await listPersonalizationMemories(userId)
    res.json(buildSuccess(requestId, { memories, archived, revision }))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.post(memoriesPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const body = parseBody(createAgentPersonalizationMemorySchema, req.body, '记忆内容无效。')
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await createPersonalizationMemory(userId, body.text, undefined, body.pinned)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.patch(memoryPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const memoryId = parseBody(agentPersonalizationMemoryIdSchema, req.params.memoryId, '记忆编号无效。')
    const body = parseBody(patchAgentPersonalizationMemorySchema, req.body, '记忆修改参数无效。')
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await updatePersonalizationMemory(userId, memoryId, body)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.post(`${memoryPath}/restore`, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const memoryId = parseBody(agentPersonalizationMemoryIdSchema, req.params.memoryId, '记忆编号无效。')
    const { expectedRevision } = parseBody(agentPersonalizationExpectedRevisionSchema, req.body, '记忆版本无效。')
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await restorePersonalizationMemory(userId, memoryId, expectedRevision)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.delete(memoryPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const memoryId = parseBody(agentPersonalizationMemoryIdSchema, req.params.memoryId, '记忆编号无效。')
    const { expectedRevision } = parseBody(deleteRevisionSchema, req.query, '记忆版本无效。')
    res.json(buildSuccess(requestId, await deletePersonalizationMemory(userId, memoryId, expectedRevision)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.delete(memoriesPath, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const { expectedRevision } = parseBody(deleteRevisionSchema, req.query, '记忆列表版本无效。')
    res.json(buildSuccess(requestId, await clearPersonalizationMemories(userId, expectedRevision)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.get(`${settingsPath}/rule-operations`, async (req, res) => {
  const requestId = createRequestId()
  try {
    await requirePersonalizationUser(req)
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await listPersonalizationRuleOperations()))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.put(`${settingsPath}/rules`, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const { toolName, permission, expectedRevision } = parseBody(writeAgentPersonalizationRuleSchema, req.body, '权限规则无效。')
    await assertPersonalizationRuleOperation(toolName)
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await changePersonalizationRule(userId, toolName, permission, expectedRevision)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

router.delete(`${settingsPath}/rules/:toolName`, async (req, res) => {
  const requestId = createRequestId()
  try {
    const userId = await requirePersonalizationUser(req)
    const toolName = parseBody(agentPersonalizationRuleNameSchema, req.params.toolName, '规则操作无效。')
    const { expectedRevision } = parseBody(deleteRevisionSchema, req.query, '设置版本无效。')
    res.setHeader('Cache-Control', 'no-store')
    res.json(buildSuccess(requestId, await changePersonalizationRule(userId, toolName, null, expectedRevision)))
  } catch (error) { sendRouteError(res, requestId, error) }
})

export default router
