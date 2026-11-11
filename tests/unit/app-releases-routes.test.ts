import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import router,{ publicAppReleaseRouter } from '../../api/routes/app-releases.js'
import { env } from '../../api/config/env.js'
const mocks=vi.hoisted(()=>({admin:vi.fn(),select:vi.fn(),import:vi.fn(),preview:vi.fn(),execute:vi.fn(),reconcile:vi.fn(),session:vi.fn(),clearSession:vi.fn(),installed:vi.fn(),file:vi.fn(),previewLaunch:vi.fn()}))
vi.mock('../../api/lib/admin-auth.js',()=>({requireAdmin:mocks.admin,getRequestIp:()=>null}))
vi.mock('../../api/lib/auth-session.js',()=>({getSessionUserId:()=>null,createSession:mocks.session,clearSession:mocks.clearSession}))
vi.mock('../../api/lib/app-releases.js',()=>({importAppRelease:mocks.import,previewAppRelease:mocks.preview,executeAppRelease:mocks.execute,reconcileAppRelease:mocks.reconcile,selectAppRelease:mocks.select,listAppReleases:vi.fn(),verifyEmailAuthPreviewLaunch:mocks.previewLaunch}))
vi.mock('../../api/lib/app-release-artifacts.js',()=>({readInstalledAppRelease:mocks.installed,readAppReleaseFile:mocks.file}))
const app=express();app.set('trust proxy',1);app.use(express.json());app.use('/public',publicAppReleaseRouter);app.use('/admin',router)
beforeEach(()=>{vi.clearAllMocks();mocks.admin.mockResolvedValue({id:'admin',isSuperAdmin:true});mocks.select.mockResolvedValue({mode:'artifact',channel:'stable',release:{id:'stable-version',label:'Stable',notes:{features:['Feature'],fixes:[],changes:[]},capabilities:[],entryUrl:'/public/artifacts/stable-version/index.html'}});mocks.installed.mockResolvedValue({manifest:{}});mocks.file.mockResolvedValue(Buffer.from('synthetic-module'))})
it('issues the browser preview only through the exact same-origin HTTPS cookie-session action',async()=>{
 const previous={webUrl:env.webUrl,authSessionSecret:env.authSessionSecret}
 Object.assign(env,{webUrl:'https://app.example.test',authSessionSecret:'synthetic-test-key'})
 const body={releaseId:'test-version',revision:7}
 const launch=()=>request(app).post('/admin/email-auth-preview').set('Host','app.example.test').set('X-Forwarded-Proto','https')
 try{
  expect((await launch().set('Origin','https://other.example.test').send(body)).status).toBe(403)
  expect((await launch().set('Origin',env.webUrl).set('Authorization','Bearer fixture').send(body)).status).toBe(403)
  expect(mocks.previewLaunch).not.toHaveBeenCalled()
  mocks.previewLaunch.mockResolvedValue('approved@example.test')
  const result=await launch().set('Origin',env.webUrl).send(body)
  expect(result.status).toBe(200)
  expect(result.headers['cache-control']).toBe('private, no-store')
  expect(result.headers['set-cookie']?.[0]).toMatch(/^__Host-chevoink_email_auth_preview=/)
  expect(JSON.stringify(result.body)).not.toContain('approved@example.test')
  expect(mocks.previewLaunch).toHaveBeenCalledWith('admin','test-version',7)
  expect(mocks.clearSession).toHaveBeenCalledTimes(1)
 }finally{Object.assign(env,previous)}
})
it('serves only the server-assigned artifact with private no-store and no manifest exposure',async()=>{let response=await request(app).get('/public/artifacts/stable-version/assets/app.js');expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');expect(response.headers.vary).toBe('Cookie, Authorization');expect(mocks.file).toHaveBeenCalledWith(expect.anything(),'assets/app.js');response=await request(app).get('/public/artifacts/test-version/assets/app.js').set('x-release-channel','test');expect(response.status).toBe(403);expect(response.body.error.code).toBe('APP_RELEASE_NOT_ASSIGNED')})
it('returns public selection without leaking exact SHA, CI, diagnostics or upstream configuration',async()=>{const response=await request(app).get('/public/bootstrap');expect(response.status).toBe(200);expect(response.body.data.release.label).toBe('Stable');expect(JSON.stringify(response.body)).not.toMatch(/sourceSha|ciRunId|artifactSha256|provider|baseUrl/)})
it('rejects client file paths and verification booleans as import evidence',async()=>{const response=await request(app).post('/admin/import').send({releaseId:'candidate',path:'/tmp/forged',verified:true,sourceSha:'a'.repeat(40)});expect(response.status).toBe(400);expect(mocks.import).not.toHaveBeenCalled()})
it('passes only release ID to the protected manifest importer',async()=>{mocks.import.mockResolvedValue({id:'candidate'});const response=await request(app).post('/admin/import').send({releaseId:'candidate'});expect(response.status).toBe(201);expect(mocks.import).toHaveBeenCalledWith('admin','candidate',null)})
it('preserves operation ID and expected revision when executing an explicitly previewed request',async()=>{mocks.execute.mockResolvedValue({status:'applied'});const body={action:'full_release',releaseId:'candidate',operationId:'00000000-0000-4000-8000-000000000001',previewHash:'b'.repeat(64),expectedRevision:3};const response=await request(app).post('/admin/execute').send(body);expect(response.status).toBe(200);expect(mocks.execute).toHaveBeenCalledWith('admin',body,null)})
