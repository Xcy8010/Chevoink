import type { AiModelConfig, Prisma } from '@prisma/client'
import type { AppReleaseCapability } from '../../shared/contracts/app-release.js'
import { selectAppReleaseForUser } from './app-releases.js'
import { DataAccessError } from './prisma.js'
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
export type ReleaseModelInput={modelKind?:unknown;imageQuality?:unknown;routes?:unknown;weightedRoutes?:unknown;activities?:unknown;freePromotion?:unknown;publicDescription?:unknown;publicFeatures?:unknown;enabled?:boolean;selectable?:boolean;testerSelectable?:boolean;isDefault?:boolean}
/** Feature membership is checked after actual route parsing as well as at the request boundary. */
export function modelInputCapabilities(input:ReleaseModelInput,image:boolean):AppReleaseCapability[]{
 const result:AppReleaseCapability[]=[]
 const routes=Array.isArray(input.routes)?input.routes:[],weighted=object(input.weightedRoutes),candidates=Array.isArray(weighted.candidates)?weighted.candidates:[]
 if(input.testerSelectable===true)result.push('testerManagement')
 if('imageQuality'in input||[...routes,...candidates].some(route=>'imageQuality'in object(route)))result.push('imageQuality')
 if('freePromotion'in input||'activities'in input)result.push('modelPromotions')
 if('publicDescription'in input||'publicFeatures'in input)result.push('publicModelDetails')
 if(image&&'weightedRoutes'in input)result.push('imageWeightedRoutes')
 return result
}
export async function assertAppReleaseModelCapabilities(tx:Prisma.TransactionClient,actorId:string,model:Pick<AiModelConfig,'metadata'>,input:ReleaseModelInput|null){
 const metadata=object(model.metadata),image=metadata.modelKind==='image_generation'
 const required=new Set(modelInputCapabilities(input??{},image))
 // Disabled restoration is deliberately not an activation. Replacement of a bound tool is.
 if(input===null||input.enabled===true||input.selectable===true||input.isDefault===true){
  const active:ReleaseModelInput={}
  if(metadata.testerSelectable===true)active.testerSelectable=true
  if(metadata.imageQuality!=null)active.imageQuality=metadata.imageQuality
  if(metadata.routes!=null)active.routes=metadata.routes
  const weighted=object(metadata.weightedRoutes)
  if(Array.isArray(weighted.candidates)&&weighted.candidates.length)active.weightedRoutes=metadata.weightedRoutes
  if(metadata.activities!=null)active.activities=metadata.activities
  if(metadata.freePromotion!=null)active.freePromotion=metadata.freePromotion
  for(const feature of modelInputCapabilities(active,image))required.add(feature)
 }
 if(!required.size)return
 const selected=await selectAppReleaseForUser(actorId,tx)
 if(selected.mode==='artifact'&&[...required].some(feature=>!selected.release!.capabilities.includes(feature)))throw new DataAccessError(403,'APP_RELEASE_CAPABILITY_DISABLED','当前应用版本不能配置或启用该模型的增量能力。')
}