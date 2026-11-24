// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AdminEmailBatchDetail } from '../../shared/contracts/admin-email.js'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../src/app/api-client', () => ({ requestJson: mocks.request }))
vi.mock('../../src/features/admin/admin-shared', () => ({
  useAdminSession: () => ({ admin: { id: 'fixture-admin', isSuperAdmin: true } }),
  formatDateTime: (date: string) => date,
}))
vi.mock('../../src/features/admin/AdminLayout', () => ({
  AdminPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  AdminCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))

import AdminEmailPage from '../../src/features/admin/pages/AdminEmailPage'

const endpoint = '/api/admin/email'
const candidateA = { id: 'a', nickname: '作者甲', maskedEmail: 'a•••@chevoink.invalid', exclusion: null }
const candidateB = { id: 'b', nickname: '作者乙', maskedEmail: 'b•••@chevoink.invalid', exclusion: null }
const preview: AdminEmailBatchDetail = {
  id: '26c7cceb-f1c1-4dbc-84e8-076b7cc84fb3', mode: 'mock', state: 'preview', previewHash: 'a'.repeat(64), replacedById: null,
  selection: { mode: 'manual', userIds: ['a', 'b'] },
  createdAt: '2026-11-24T03:00:00Z', expiresAt: '2099-11-24T04:00:00Z',
  recipientCount: 2, candidateCount: 2, eligibleCount: 2, progress: { preview: 2 }, exclusions: {}, blocker: null,
  template: {
    id: 'tester-invitation-v1', subject: '内测邀请', from: '通知 <notices@chevoink.invalid>',
    replyTo: 'support@chevoink.invalid', sampleBody: '作者甲，您好。欢迎参与内测。',
  },
  recipients: [candidateA, candidateB].map(({ id, nickname, maskedEmail }) => ({
    userId: id, nickname, maskedEmail, state: 'preview', reason: null, providerMessageId: null,
    providerRequestId: null, attemptedAt: null, updatedAt: '2026-11-24T03:00:00Z',
  })),
}

function CurrentUrl() {
  const location = useLocation()
  return <output data-testid="preview-url">{location.search}</output>
}

function mount(entry = '/admin/email') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[entry]}><AdminEmailPage /><CurrentUrl /></MemoryRouter>
  </QueryClientProvider>)
}

beforeEach(() => {
  mocks.request.mockReset()
  mocks.request.mockImplementation(async (path: string) => {
    if (path === `${endpoint}/settings`) return { mode: 'mock' }
    if (path === `${endpoint}/templates` || path === `${endpoint}/segments`) return { items: [] }
    if (path === `${endpoint}/batches`) return { items: [] }
    if (path.startsWith(`${endpoint}/candidates?`)) {
      const first = new URLSearchParams(path.split('?')[1]).get('page') === '1'
      return { hasNextPage: first, items: first ? [candidateA] : [candidateB] }
    }
    if (path === `${endpoint}/previews` || path === `${endpoint}/batches/${preview.id}`) return preview
    if (path === `${endpoint}/batches/${preview.id}/confirm`) {
      return {
        ...preview, state: 'confirmed', progress: { delivered: 2 },
        recipients: preview.recipients.map(row => ({ ...row, state: 'delivered', providerMessageId: `mock-message-${row.userId}` })),
      }
    }
    throw new Error(`Unexpected mock route: ${path}`)
  })
})
afterEach(cleanup)

it('keeps cross-page selections, restores the saved preview from its URL, and confirms that snapshot', async () => {
  const firstVisit = mount()
  fireEvent.change(await screen.findByLabelText('选择模板'), {target: {value: '0'}})
  fireEvent.click(screen.getByText('选择收件人', { selector:'button[type=submit]' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: /作者甲/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: /作者乙/ }))
  expect(screen.getByText('已选 2 / 100')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '生成发送预览' }))
  await screen.findByRole('button', { name: '确认模拟发送给 2 人' })
  const search = screen.getByTestId('preview-url').textContent
  expect(search).toBe(`?batch=${preview.id}`)
  expect(mocks.request).toHaveBeenCalledWith(`${endpoint}/previews`, {
    method: 'POST', body: JSON.stringify({ mode: 'mock', selection: preview.selection }),
  })
  firstVisit.unmount()

  mount(`/admin/email${search}`)
  const confirm = await screen.findByRole('button', { name: '确认模拟发送给 2 人' })
  expect(screen.getByText('作者甲，您好。欢迎参与内测。')).toBeTruthy()
  fireEvent.click(confirm)
  await screen.findByText('mock-message-a')
  expect(mocks.request).toHaveBeenCalledWith(`${endpoint}/batches/${preview.id}/confirm`, {
    method: 'POST', body: JSON.stringify({ mode: 'mock', previewHash: preview.previewHash }),
  })
  expect(mocks.request.mock.calls.filter(([path]) => path === `${endpoint}/previews`)).toHaveLength(1)
})

it('redraws an existing sample by sending its original criteria and the replaced preview ID', async () => {
  const selection = { mode: 'sample', filters: { tester: 'effective' }, size: 2, weighting: 'recent_activity' }
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `${endpoint}/batches/${preview.id}` || path === `${endpoint}/previews`) return { ...preview, selection }
    return original(path, init)
  })
  mount(`/admin/email?batch=${preview.id}`)
  fireEvent.click(await screen.findByRole('button', { name: '重新抽样并预览' }))
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(`${endpoint}/previews`, {
    method: 'POST', body: JSON.stringify({ mode: 'mock', selection, replaces: preview.id }),
  }))
})

it('follows a saved replacement after a redraw response is lost', async () => {
  const replacement = '913aadc7-73f2-4a80-aae4-11b0dfcd71ec'
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `${endpoint}/batches/${preview.id}`) return { ...preview, replacedById: replacement }
    if (path === `${endpoint}/batches/${replacement}`) return { ...preview, id: replacement }
    return original(path, init)
  })
  mount(`/admin/email?batch=${preview.id}`)
  expect(await screen.findByText('此预览已被替换。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /确认模拟发送/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '查看替换后的预览' }))
  await screen.findByRole('button', { name: '确认模拟发送给 2 人' })
  expect(screen.getByTestId('preview-url').textContent).toBe(`?batch=${replacement}`)
  expect(mocks.request.mock.calls.some(([path]) => path === `${endpoint}/previews`)).toBe(false)
})

it('adds a template, previews its subject and body variables, and composes to typed addresses', async () => {
  const item = {id:77301, name:'续写邀请', subject:'致 {{ reader }}', body:'欢迎领取 {{credits}} Credits。'}
  const original = mocks.request.getMockImplementation()!
  let saved = false
  mocks.request.mockImplementation(async (path: string, init?:RequestInit) => {
    if(path===endpoint+'/templates'){
      if(init?.method==='POST'){expect(JSON.parse(init.body as string)).toEqual(item); saved=true; return item}
      return {items:saved?[item]:[]}
    }
    return original(path, init)
  })
  mount()
  fireEvent.click(await screen.findByRole('button',{name:'模板库'}))
  fireEvent.click(screen.getByRole('button',{name:'添加模板'}))
  for (const [label,value] of [['腾讯云 SES 模板 ID','77301'],['模板名称',item.name],['邮件主题',item.subject],['模板正文',item.body]]){
    fireEvent.change(screen.getByLabelText(label),{target:{value}})
  }
  fireEvent.click(screen.getByRole('button',{name:'保存模板'}))
  fireEvent.click(await screen.findByRole('button',{name:'使用此模板'}))
  fireEvent.change(await screen.findByLabelText('reader'),{target:{value:'作者甲'}})
  fireEvent.change(screen.getByLabelText('credits'),{target:{value:'120'}})
  expect(screen.getByTitle('邮件正文预览').getAttribute('srcdoc')).toContain('120 Credits')
  expect(screen.getByText('致 作者甲')).toBeTruthy()
  fireEvent.click(screen.getByText('选择收件人',{selector:'button[type=submit]'}))
  fireEvent.change(screen.getByLabelText('选择方式'),{target:{value:'emails'}})
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Creator@example.test，creator@example.test'}})
  fireEvent.click(screen.getByRole('button',{name:'生成发送预览'}))
  await waitFor(()=>expect(mocks.request.mock.calls.some(([path, init])=>path===endpoint+'/previews' &&
    JSON.stringify(JSON.parse(init.body).selection)===JSON.stringify({mode:'emails',emails:['creator@example.test']}) &&
    JSON.parse(init.body).customTemplate.values.reader==='作者甲')).toBe(true))
})
