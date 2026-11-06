import { createHash } from 'node:crypto'
import type { AiModelConfig, Prisma } from '@prisma/client'
import { presentModelRoutes } from './model-route-pool.js'
import { presentWeightedRoutes } from './model-weighted-config.js'
import { parseModelCapabilities } from './credits.js'
import { readModelPromotion } from '../../shared/model-promotion.js'
import { imageQualityConfigSchema } from '../../shared/contracts/image-model.js'

function endpoint(value: string | null): Prisma.InputJsonValue | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return { origin: url.origin, pathFingerprint: createHash('sha256').update(url.pathname).digest('hex'), hasQuery: Boolean(url.search) }
  } catch { return { invalid: true } }
}
function snapshot(model: AiModelConfig): Record<string, Prisma.InputJsonValue | null> {
  const capabilities = parseModelCapabilities(model.metadata,model.provider)
  const weighted = presentWeightedRoutes(model.metadata)
  const metadata = model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata) ? model.metadata : {}
  const imageQuality = imageQualityConfigSchema.safeParse(metadata.imageQuality)
  return {
    displayName:model.displayName,provider:model.provider,modelName:model.modelName,endpoint:endpoint(model.baseUrl),keyConfigured:Boolean(model.apiKeyCiphertext),
    multiplierBps:model.multiplierBps,enabled:model.enabled,selectable:model.selectable,testerSelectable:metadata.testerSelectable === true,isDefault:model.isDefault,
    capabilities:JSON.parse(JSON.stringify(capabilities)) as Prisma.InputJsonObject,
    webToolProtocol:metadata.webToolProtocol === 'deepseek' || metadata.webToolProtocol === 'bocha' ? metadata.webToolProtocol : null,
    imageQuality:imageQuality.success ? imageQuality.data : null,
    freePromotion:readModelPromotion(model.metadata) as Prisma.InputJsonValue | null,
    routes:presentModelRoutes(model.metadata).map(route=>({id:route.id,label:route.label,provider:route.provider,modelName:route.modelName,enabled:route.enabled,endpoint:endpoint(route.baseUrl),keyConfigured:route.apiKeyConfigured,contextWindowTokens:route.contextWindowTokens ?? null,reasoningEfforts:route.reasoningEfforts ?? null,visionEnabled:route.visionEnabled ?? null})),
    weightedRoutes:weighted?{primaryWeight:weighted.primaryWeight,candidates:weighted.candidates.map(route=>({id:route.id,label:route.label,provider:route.provider,modelName:route.modelName,weight:route.weight,endpoint:endpoint(route.baseUrl),keyConfigured:route.apiKeyConfigured}))}:null,
  }
}
export function adminModelChangeDetail(before: AiModelConfig,after: AiModelConfig,keyReplaced: boolean,routeKeysReplaced: string[] = []): Prisma.InputJsonObject {
  const previous=snapshot(before),next=snapshot(after)
  const changes=Object.keys(next).filter(field=>JSON.stringify(previous[field])!==JSON.stringify(next[field])).map(field=>({field,before:previous[field],after:next[field]}))
  return {fromRevision:before.revision,toRevision:after.revision,changes,keyReplaced,routeKeysReplaced}
}
