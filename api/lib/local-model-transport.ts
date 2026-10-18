import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma, DataAccessError } from './prisma.js'
import { decryptSecret } from './secret-box.js'
import { localModelBroker, LocalModelTransportError } from './local-model-broker.js'
import { isLocalModelProvider, normalizeLocalModelUrl } from '../../shared/local-model.js'

export function newConnectorToken(modelId: string): string { return `chevoink-local-v1.${modelId}.${randomBytes(32).toString('base64url')}` }
export function connectorKey(token: string): string { return createHash('sha256').update(token).digest('hex') }
export async function authenticateConnector(token: string) {
  const match = /^chevoink-local-v1\.([\w-]{1,64})\.([\w-]{43})$/.exec(token)
  if (!match) throw new DataAccessError(401, 'CONNECTOR_AUTH_REQUIRED', '本地连接器凭据无效或已撤销。')
  const row = await prisma.aiModelConfig.findUnique({ where: { id: match[1] }, include: { owner: { select: { tokenVersion: true, bannedAt: true } } } })
  const metadata = row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {}
  const saved = row?.apiKeyCiphertext ? decryptSecret(row.apiKeyCiphertext) : ''
  if (!row?.ownerUserId || !row.owner || row.owner.bannedAt || !isLocalModelProvider(row.provider)
    || row.owner.tokenVersion !== metadata.connectorOwnerTokenVersion || saved.length !== token.length || !timingSafeEqual(Buffer.from(saved), Buffer.from(token))) {
    throw new DataAccessError(401, 'CONNECTOR_AUTH_REQUIRED', '本地连接器凭据无效或已撤销。')
  }
  return { row, key: connectorKey(token) }
}
type LocalRequest = { userId: string; provider: string; baseUrl: string; apiKey: string; body: string; signal?: AbortSignal; validation?: boolean }
async function boundLocalRequest(input: LocalRequest) {
  const { row, key } = await authenticateConnector(input.apiKey).catch(() => { throw new LocalModelTransportError(false, '本地模型连接凭据已失效，未派发请求。') })
  const payload = JSON.parse(input.body) as { model?: unknown; tools?: unknown[] }
  if (row.ownerUserId !== input.userId || row.provider !== input.provider || normalizeLocalModelUrl(row.baseUrl!) !== normalizeLocalModelUrl(input.baseUrl)
    || row.modelName !== payload.model || !input.validation && !row.enabled) throw new LocalModelTransportError(false, '本地模型身份或配置已变化，未派发请求。')
  const metadata = row.metadata as Record<string, unknown>
  const capabilities = metadata.capabilityValidation as Record<string, unknown> | undefined
  if (!input.validation && payload.tools?.length && capabilities?.tools !== 'verified') throw new LocalModelTransportError(false, '该本地模型的原生工具能力尚未验证，未派发 Agent 请求。')
  return key
}
export async function assertLocalModelReady(input: LocalRequest): Promise<void> {
  const key = await boundLocalRequest(input)
  if (!localModelBroker.online(key)) throw new LocalModelTransportError(false, '本地连接器未在线，模型请求未派发。')
}
export async function localModelFetch(input: LocalRequest): Promise<Response> {
  const key = await boundLocalRequest(input)
  return localModelBroker.request(key, input.body, input.signal)
}
