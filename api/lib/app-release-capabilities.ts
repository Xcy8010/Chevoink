import { modelInputCapabilities } from './app-release-model-capabilities.js'
import type { Request, Response, NextFunction } from 'express'
import type { AppReleaseCapability } from '../../shared/contracts/app-release.js'
import { requireAdmin } from './admin-auth.js'
import { requireSessionUserId } from './auth-session.js'
import { requireAppReleaseCapability, selectAppRelease } from './app-releases.js'
import { prisma } from './prisma.js'
import { createRequestId } from './http.js'
import { sendRouteError } from './route-error.js'

export async function appReleaseCapabilityGuard(req:Request,res:Response,next:NextFunction){
 const rawPath=req.path.replace(/\/+$/,'')||'/'
 const path=rawPath.toLowerCase()
 const capabilities:AppReleaseCapability[]=[]
 const adminContent=/^\/admin\/site-content(?:\/|$)/.test(path),publicContent=/^\/site-content(?:\/|$)/.test(path),testers=/^\/admin\/testers(?:\/|$)/.test(path)
 const identityTesterWrite=req.method==='PUT'&&/^\/admin\/users\/[^/]+\/identity$/.test(path)&&Boolean(req.body&&typeof req.body==='object'&&'tester'in req.body)
 const modelWrite=['POST','PATCH','PUT'].includes(req.method)&&/^\/admin\/models(?:\/[^/]+)?$/.test(path)
 const summary=req.method==='GET'&&path==='/credits/summary'
 if(!adminContent&&!publicContent&&!testers&&!identityTesterWrite&&!modelWrite&&!summary){next();return}
 const requestId=createRequestId()
 try{
  if(adminContent||testers||identityTesterWrite||modelWrite)await requireAdmin(req)
  if(summary)requireSessionUserId(req)
  if(adminContent||publicContent)capabilities.push('siteContent')
  if(testers||identityTesterWrite)capabilities.push('testerManagement')
  if(modelWrite&&req.body&&typeof req.body==='object'&&!Array.isArray(req.body)){
   const body=req.body as Record<string,unknown>
   let image=body.modelKind==='image_generation'
   if(req.method!=='POST'&&rawPath.split('/')[3]){const model=await prisma.aiModelConfig.findUnique({where:{id:decodeURIComponent(rawPath.split('/')[3])},select:{metadata:true}});const metadata=model?.metadata;image=image||Boolean(metadata&&typeof metadata==='object'&&!Array.isArray(metadata)&&metadata.modelKind==='image_generation')}
   capabilities.push(...modelInputCapabilities(body,image))
  }
  for(const capability of capabilities)await requireAppReleaseCapability(req,capability)
  if(summary){
   const selection=await selectAppRelease(req)
   if(selection.mode==='artifact'){
    const allowed=selection.release!.capabilities,send=res.json.bind(res)
    res.json=(body:unknown)=>{
     if(body&&typeof body==='object'&&'data'in body){const envelope=body as {data?:unknown};if(envelope.data&&typeof envelope.data==='object'&&'models'in envelope.data){const data=envelope.data as {models:unknown};if(Array.isArray(data.models))return send({...body,data:{...envelope.data,models:data.models.map((value:unknown)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return value
      const model={...value} as Record<string,unknown>
      if(!allowed.includes('publicModelDetails')){delete model.publicDescription;delete model.publicFeatures}
      if(!allowed.includes('modelPromotions')){delete model.freePromotion;delete model.activity}
      return model
     })}})}}
     return send(body)
    }
   }
  }
  next()
 }catch(error){sendRouteError(res,requestId,error)}
}