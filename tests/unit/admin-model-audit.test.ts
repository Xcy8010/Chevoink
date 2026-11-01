import type { AiModelConfig, Prisma } from '@prisma/client'
import { expect, it } from 'vitest'
import { adminModelChangeDetail } from '../../api/lib/admin-model-audit.js'

function model(metadata: Prisma.JsonValue): AiModelConfig {
  return {id:'synthetic-model',ownerUserId:null,key:'builtin:synthetic',provider:'synthetic',displayName:'合成模型',modelName:'synthetic',baseUrl:'https://example.invalid/v1/private?token=synthetic-query',apiKeyCiphertext:'synthetic-opaque-cipher',tier:'speed',multiplierBps:10000,enabled:true,selectable:true,isDefault:false,sortOrder:1,metadata,createdAt:new Date(0),updatedAt:new Date(0),revision:1,archivedAt:null,archivedById:null,archiveReason:null}
}
it('records protocol-only and image-quality-only behavior changes without arbitrary metadata or credentials',()=>{
  const before = model({webToolProtocol:'deepseek',imageQuality:{supportedValues:['low','high'],defaultValue:'low'},privateValue:'synthetic-private-metadata'})
  const after = {...before,revision:2,metadata:{webToolProtocol:'bocha',imageQuality:{supportedValues:['low','high'],defaultValue:'high'},privateValue:'changed-private-metadata'}}
  const detail = adminModelChangeDetail(before,after,false)
  expect(detail.changes).toEqual(expect.arrayContaining([
    {field:'webToolProtocol',before:'deepseek',after:'bocha'},
    {field:'imageQuality',before:{supportedValues:['low','high'],defaultValue:'low'},after:{supportedValues:['low','high'],defaultValue:'high'}},
  ]))
  for(const secret of ['synthetic-opaque-cipher','synthetic-query','/v1/private','privateValue','changed-private-metadata'])expect(JSON.stringify(detail)).not.toContain(secret)
})
it('tracks original route capability-only edits and presents URL fingerprints without query strings or ciphertext',()=>{
  const route={id:'00000000-0000-4000-8000-000000000001',label:'合成线路',provider:'synthetic',modelName:'synthetic-route',baseUrl:'https://example.invalid/secret-path?token=synthetic-query',apiKeyCiphertext:'synthetic-route-cipher',enabled:true,contextWindowTokens:64000,reasoningEfforts:['high'],visionEnabled:false}
  const before=model({routes:[route]})
  const after={...before,revision:2,metadata:{routes:[{...route,contextWindowTokens:128000,reasoningEfforts:['high','max'],visionEnabled:true}]}}
  const detail=adminModelChangeDetail(before,after,false)
  expect(detail.changes).toEqual([expect.objectContaining({field:'routes',before:[expect.objectContaining({contextWindowTokens:64000,reasoningEfforts:['high'],visionEnabled:false})],after:[expect.objectContaining({contextWindowTokens:128000,reasoningEfforts:['high','max'],visionEnabled:true,endpoint:{origin:'https://example.invalid',pathFingerprint:expect.any(String),hasQuery:true}})]})])
  for(const secret of ['synthetic-route-cipher','synthetic-opaque-cipher','synthetic-query','secret-path'])expect(JSON.stringify(detail)).not.toContain(secret)
})
