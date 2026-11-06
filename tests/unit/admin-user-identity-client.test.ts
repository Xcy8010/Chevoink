import { beforeEach, expect, it, vi } from 'vitest'
const request=vi.hoisted(()=>vi.fn())
vi.mock('../../src/app/api-client',()=>({requestJson:request}))
import { updateAdminUserIdentity } from '../../src/features/admin/api'
beforeEach(()=>request.mockReset())
it('uses the atomic identity endpoint with the exact versioned request and an encoded target',async()=>{
 const input={operationId:'00000000-0000-4000-8000-000000000001',tester:{enabled:true,expiresAt:null,reason:'合成授权原因',expectedRevision:4}}
 request.mockResolvedValue({role:'user',tester:{enabled:true,effective:true,revision:5,expiresAt:null,reason:input.tester.reason},replayed:false})
 await updateAdminUserIdentity('user/one',input)
 expect(request).toHaveBeenCalledWith('/api/admin/users/user%2Fone/identity',{method:'PUT',body:JSON.stringify(input)})
})
