import { Router } from 'express'
import path from 'node:path'
import { z } from 'zod'
import { appReleaseExecuteSchema, appReleaseIdSchema, appReleasePreviewSchema } from '../../shared/contracts/app-release.js'
import { requireAdmin, getRequestIp } from '../lib/admin-auth.js'
import { clearSession, createSession, getSessionUserId } from '../lib/auth-session.js'
import { executeAppRelease, importAppRelease, listAppReleases, previewAppRelease, reconcileAppRelease, selectAppRelease, verifyEmailAuthPreviewLaunch } from '../lib/app-releases.js'
import { writeAccountEmailAuthPreviewGrant } from '../lib/account-email-auth-scope.js'
import { env } from '../config/env.js'
import { readInstalledAppRelease, readAppReleaseFile } from '../lib/app-release-artifacts.js'
import { buildSuccess, createRequestId } from '../lib/http.js'
import { parseBody } from '../lib/parse-body.js'
import { sendRouteError } from '../lib/route-error.js'
import { DataAccessError } from '../lib/prisma.js'
export const publicAppReleaseRouter=Router()
publicAppReleaseRouter.get('/bootstrap',async(req,res)=>{
 const id=createRequestId()
 try{
  const selection=await selectAppRelease(req)
  const userId=getSessionUserId(req)
  // A validated Bearer-only WebView session needs same-origin cookies for module requests.
  if(selection.mode==='artifact'&&userId&&req.headers.authorization?.startsWith('Bearer ')&&!req.headers.cookie?.includes('chevoink_session='))await createSession(userId,res)
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie, Authorization');res.json(buildSuccess(id,selection))
 }catch(error){sendRouteError(res,id,error)}
})
publicAppReleaseRouter.get('/artifacts/:releaseId/*',async(req,res)=>{
 const id=createRequestId()
 try{
  const selection=await selectAppRelease(req)
  if(selection.mode!=='artifact'||selection.release?.id!==req.params.releaseId)throw new DataAccessError(403,'APP_RELEASE_NOT_ASSIGNED','此版本未分配给当前账号。')
  const installed=await readInstalledAppRelease(req.params.releaseId)
  const filename=(req.params as Record<string,string>)['0']
  const bytes=await readAppReleaseFile(installed,filename)
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie, Authorization');res.setHeader('X-Content-Type-Options','nosniff')
  res.type(path.extname(filename));res.send(bytes)
 }catch(error){sendRouteError(res,id,error)}
})
const router=Router()
router.get('/',async(req,res)=>{const id=createRequestId();try{const actor=await requireAdmin(req);res.json(buildSuccess(id,await listAppReleases(actor.id)))}catch(error){sendRouteError(res,id,error)}})
router.post('/email-auth-preview',async(req,res)=>{
 const id=createRequestId()
 try{
  const web=new URL(env.webUrl)
  if(web.protocol!=='https:'||!req.secure||req.get('Origin')!==web.origin||req.get('Host')!==web.host||req.get('Authorization')){
   throw new DataAccessError(403,'AUTH_PREVIEW_ORIGIN_REQUIRED','请在本站网页中开启邮箱注册预览。')
  }
  const actor=await requireAdmin(req)
  const body=parseBody(z.object({releaseId:appReleaseIdSchema,revision:z.number().int().positive()}).strict(),req.body,'请选择当前测试版。')
  const recipient=await verifyEmailAuthPreviewLaunch(actor.id,body.releaseId,body.revision)
  writeAccountEmailAuthPreviewGrant(res,{issuerId:actor.id,...body},recipient)
  // The preview starts anonymous in this browser. Other device sessions stay valid.
  clearSession(res)
  res.setHeader('Cache-Control','private, no-store')
  res.json(buildSuccess(id,{ok:true}))
 }catch(error){sendRouteError(res,id,error)}
})
router.post('/import',async(req,res)=>{const id=createRequestId();try{const actor=await requireAdmin(req);const body=parseBody(z.object({releaseId:appReleaseIdSchema}).strict(),req.body,'请填写已由受控流程准备的版本编号。');res.status(201).json(buildSuccess(id,await importAppRelease(actor.id,body.releaseId,getRequestIp(req))))}catch(error){sendRouteError(res,id,error)}})
router.post('/preview',async(req,res)=>{const id=createRequestId();try{const actor=await requireAdmin(req);const body=parseBody(appReleasePreviewSchema,req.body,'请选择具体版本与操作。');res.json(buildSuccess(id,await previewAppRelease(actor.id,body.action,body.releaseId)))}catch(error){sendRouteError(res,id,error)}})
router.post('/execute',async(req,res)=>{const id=createRequestId();try{const actor=await requireAdmin(req);const body=parseBody(appReleaseExecuteSchema,req.body,'请先预览并确认本次具体版本操作。');res.json(buildSuccess(id,await executeAppRelease(actor.id,body,getRequestIp(req))))}catch(error){sendRouteError(res,id,error)}})
router.get('/operations/:operationId',async(req,res)=>{const id=createRequestId();try{const actor=await requireAdmin(req);const operationId=parseBody(z.string().uuid(),req.params.operationId,'操作编号无效。');res.json(buildSuccess(id,await reconcileAppRelease(actor.id,operationId)))}catch(error){sendRouteError(res,id,error)}})
export default router
