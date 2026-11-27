// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastContext } from '../../src/components/ui/toast-context'
import AdminUsersPage from '../../src/features/admin/pages/AdminUsersPage'
import AdminUserDetailPage from '../../src/features/admin/pages/AdminUserDetailPage'
import { requestJson } from '../../src/app/api-client'

vi.mock('../../src/app/api-client', async (original) => ({
  ...await original<typeof import('../../src/app/api-client')>(), requestJson:vi.fn(),
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it.each(['list','detail'])('issues a reasoned restriction from the actual user %s', async (mode) => {
  const user = { id:'user-only',nickname:'合成账号',role:'user',createdAt:new Date().toISOString(),lastActiveAt:null,
    novelCount:0,postCount:0,followerCount:0,bannedAt:null }
  const decisions: Record<string,unknown>[] = []
  vi.mocked(requestJson).mockImplementation(async (path, options) => {
    if (path === '/api/admin/me') return {id:'admin',role:'admin'}
    if (path.startsWith('/api/admin/governance/restrictions')) {
      if (options?.method === 'POST') decisions.push(JSON.parse(String(options.body)))
      return {items:[],legacyOnly:false,nextCursor:null}
    }
    if (path === '/api/admin/users/user-only') return {user,stats:{novels:0,posts:0,comments:0,favorites:0,totalTokens:0,webSearchCalls:0,imageCalls:0}}
    if (path.startsWith('/api/admin/users?')) return {items:[user],pagination:{page:1,pageSize:10,total:1,totalPages:1}}
    throw Error('Unexpected synthetic path '+path)
  })
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  const toast={toast:vi.fn(),error:vi.fn(),info:vi.fn(),success:vi.fn()}
  render(<QueryClientProvider client={client}><ToastContext.Provider value={toast}><MemoryRouter initialEntries={[mode==='list'?'/admin/users':'/admin/users/user-only']}>
    <Routes><Route path="/admin/users" element={<AdminUsersPage/>}/><Route path="/admin/users/:userId" element={<AdminUserDetailPage/>}/></Routes>
  </MemoryRouter></ToastContext.Provider></QueryClientProvider>)
  const buttons = await screen.findAllByRole('button',{name:'管理使用限制'})
  fireEvent.click(buttons[0])
  expect(screen.getByRole('heading',{name:'合成账号 的使用限制'})).toBeTruthy()
  expect(screen.getAllByRole('checkbox')).toHaveLength(7)
  const field = screen.getByLabelText('用户 ID') as HTMLInputElement
  expect(field.readOnly).toBe(true)
  fireEvent.change(screen.getByLabelText('常见理由'),{target:{value:'骚扰辱骂或威胁他人'}})
  expect((screen.getByLabelText('处置理由') as HTMLTextAreaElement).value).toBe('骚扰辱骂或威胁他人')
  fireEvent.change(screen.getByLabelText('处置理由'),{target:{value:'本次经独立核实的具体事实'}})
  fireEvent.change(screen.getByLabelText('协议条款'),{target:{value:'用户服务协议第六节'}})
  fireEvent.click(screen.getByLabelText('发送私信'))
  fireEvent.click(screen.getByLabelText('帖子评论'))
  fireEvent.change(screen.getByLabelText('限制期限'),{target:{value:'3'}})
  await waitFor(()=>expect((screen.getByRole('button',{name:'执行限制'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:'执行限制'}))
  await waitFor(()=>expect(decisions).toHaveLength(1))
  expect(decisions[0]).toMatchObject({userId:user.id,reason:'本次经独立核实的具体事实',clause:'用户服务协议第六节',
    scopes:['direct_message','post_comment'],confirmPlatform:false})
  expect(Date.parse(String(decisions[0].expiresAt))-Date.now()).toBeGreaterThan(2.99*86400_000)
})
