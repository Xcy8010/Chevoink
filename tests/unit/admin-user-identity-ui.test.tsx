// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/app/api-client'
import AdminUserIdentityDialog from '../../src/features/admin/components/AdminUserIdentityDialog'
import type { AdminUserRow } from '../../shared/contracts'
const mocks=vi.hoisted(()=>({update:vi.fn(),detail:vi.fn()}))
vi.mock('../../src/features/admin/api',()=>({updateAdminUserIdentity:mocks.update,getAdminUserDetail:mocks.detail}))
const operationId='00000000-0000-4000-8000-000000000001'
const user:AdminUserRow={id:'synthetic-user',nickname:'合成用户',avatarUrl:null,phone:null,email:null,role:'user',isSuperAdmin:false,tester:{enabled:false,effective:false,revision:3,expiresAt:null,reason:null},bannedAt:null,createdAt:'2026-11-01T00:00:00Z',lastActiveAt:null,isOnline:false,novelCount:0,postCount:0,followerCount:0}
function mount(target=user,isSuperAdmin=true,adminId='synthetic-admin'){
 const saved=vi.fn(),close=vi.fn()
 render(<AdminUserIdentityDialog user={target} adminId={adminId} isSuperAdmin={isSuperAdmin} onSaved={saved} onClose={close}/>)
 return {saved,close}
}
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(crypto,'randomUUID').mockReturnValue(operationId);mocks.update.mockResolvedValue({role:'user',tester:{...user.tester,enabled:true,effective:true,revision:4},replayed:false});mocks.detail.mockResolvedValue({user})})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('keeps a clean form disabled and saves role and tester together only after an explicit save',async()=>{
 const {saved}=mount()
 expect(screen.getByRole('button',{name:'保存身份'}).hasAttribute('disabled')).toBe(true)
 fireEvent.change(screen.getByRole('combobox',{name:'角色'}),{target:{value:'admin'}})
 fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}))
 fireEvent.change(screen.getByRole('combobox',{name:'资格期限'}),{target:{value:'scheduled'}})
 fireEvent.change(screen.getByLabelText('到期时间（北京时间 UTC+8）'),{target:{value:'2026-12-01T08:30'}})
 expect(mocks.update).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(mocks.update).toHaveBeenCalledWith(user.id,{operationId,role:'admin',expectedRole:'user',tester:{enabled:true,expiresAt:'2026-12-01T00:30:00.000Z',reason:'在用户管理授予测试员权益',expectedRevision:3}})
})
it('lets an ordinary administrator grant tester without sending a role mutation',async()=>{
 mount(user,false)
 expect(screen.getByRole('combobox',{name:'角色'}).hasAttribute('disabled')).toBe(true)
 fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}))
 fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 await waitFor(()=>expect(mocks.update).toHaveBeenCalled())
 expect(mocks.update.mock.calls[0][1]).toEqual({operationId,tester:{enabled:true,expiresAt:null,reason:'在用户管理授予测试员权益',expectedRevision:3}})
})
it('protects a super administrator role and default tester qualification, and prevents self role changes',()=>{
 mount({...user,role:'admin',isSuperAdmin:true})
 expect((screen.getByRole('checkbox',{name:'测试员'}) as HTMLInputElement).checked).toBe(true)
 expect(screen.getByRole('checkbox',{name:'测试员'}).closest('fieldset[disabled]')).toBeTruthy()
 expect(screen.getByRole('combobox',{name:'角色'}).hasAttribute('disabled')).toBe(true)
 expect(screen.getByRole('button',{name:'保存身份'}).hasAttribute('disabled')).toBe(true)
 cleanup();mount({...user,role:'admin'},true,user.id)
 expect(screen.getByRole('combobox',{name:'角色'}).hasAttribute('disabled')).toBe(true)
})
it('revokes tester with an explicit default reason and preserves the expected tester revision',async()=>{
 mount({...user,tester:{enabled:true,effective:true,revision:8,expiresAt:null,reason:null}})
 fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}))
 fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 await waitFor(()=>expect(mocks.update).toHaveBeenCalledWith(user.id,{operationId,tester:{enabled:false,expiresAt:null,reason:'在用户管理撤销测试员权益',expectedRevision:8}}))
})
it('retries an unknown result with the exact same operation and does not allow payload edits',async()=>{
 mocks.update.mockRejectedValueOnce(Error('response lost'))
 const {saved}=mount()
 fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}));fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 await screen.findByText('保存结果尚未确认，请重试同一次保存。')
 expect(saved).not.toHaveBeenCalled()
 expect(screen.getByRole('checkbox',{name:'测试员'}).closest('fieldset[disabled]')).toBeTruthy()
 const first=mocks.update.mock.calls[0][1]
 fireEvent.click(screen.getByRole('button',{name:'重试保存'}))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(mocks.update.mock.calls[1][1]).toEqual(first)
 expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
})
it('blocks a revision conflict until a successful explicit reload and uses the refreshed revision',async()=>{
 mocks.update.mockRejectedValueOnce(new ApiClientError('用户身份已变更。',409))
 mocks.detail.mockResolvedValue({user:{...user,tester:{...user.tester,revision:9}}})
 mount();fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}));fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 const reload=await screen.findByRole('button',{name:'重新载入用户资料'})
 expect(screen.getByRole('button',{name:'保存身份'}).hasAttribute('disabled')).toBe(true)
 fireEvent.click(reload)
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull())
 expect(screen.getByRole('button',{name:'保存身份'}).hasAttribute('disabled')).toBe(true)
 fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}));fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 await waitFor(()=>expect(mocks.update).toHaveBeenCalledTimes(2))
 expect(mocks.update.mock.calls[1][1].tester.expectedRevision).toBe(9)
})
it('does not silently normalize an unchanged legacy author role into a user mutation',async()=>{
 mount({...user,role:'author'})
 fireEvent.click(screen.getByRole('checkbox',{name:'测试员'}));fireEvent.click(screen.getByRole('button',{name:'保存身份'}))
 await waitFor(()=>expect(mocks.update).toHaveBeenCalled())
 expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('role')
 expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('expectedRole')
})
