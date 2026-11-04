// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { AdminYunshuModelUsage } from '../../shared/contracts/admin-yunshu-usage.js'
const mocks = vi.hoisted(() => ({ yunshu: vi.fn(), local: vi.fn() }))
vi.mock('../../src/features/admin/api', () => ({ getAdminYunshuModelUsage: mocks.yunshu, getAdminTokenManagement: mocks.local }))
vi.mock('../../src/features/admin/admin-shared', () => ({ formatTokens: (value: number) => String(value) }))
vi.mock('../../src/features/admin/components/AdminYunshuOperations',()=>({default:()=>null}))
import AdminYunshuModelUsage from '../../src/features/admin/components/AdminYunshuModelUsage'
import AdminTokenManagementPage from '../../src/features/admin/pages/AdminTokenManagementPage'

function fixture(period: 'today' | 'week' | 'month' = 'today'): AdminYunshuModelUsage {
  return { source:'yunshu_admin_logs',scope:'configured_platform_tokens',period,window:{from:'2026-11-03T16:00:00Z',to:'2026-11-04T10:00:00Z'},observedAt:'2026-11-04T10:00:00Z',state:'partial',coverage:'partial',paginationComplete:true,message:'仅覆盖已配置的平台令牌。',lastAttemptAt:'2026-11-04T10:00:00Z',sources:{configured:2,verified:1,unresolved:1},models:[{modelName:`gateway-${period}`,group:'platform-group',requestCount:3,requestTokens:100,responseTokens:20,cacheHitTokens:null,cacheWriteTokens:0,errorCount:2,refundCount:1}] }
}
let client: QueryClient
beforeEach(() => { vi.clearAllMocks(); client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false}}}); mocks.yunshu.mockImplementation(async (period) => fixture(period)); vi.spyOn(document,'hasFocus').mockReturnValue(true) })
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers() })
const mount = (element = <AdminYunshuModelUsage period="today" />) => render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>)

it('automatically queries its period, shows upstream identity/nulls and separates error/refund counts from tokens', async () => {
  mount()
  const table = await screen.findByRole('table', {name:'云枢管理日志模型用量'})
  expect(mocks.yunshu).toHaveBeenCalledWith('today',expect.any(AbortSignal))
  const cells=within(table).getAllByRole('cell').map(cell=>cell.textContent)
  expect(cells).toEqual(['gateway-todayplatform-group','100','20','120','—','0','3','2','1'])
  expect(screen.getByText('部分覆盖')).toBeTruthy()
  expect(screen.getByText('来源 1 / 2 · 1 项未核实')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'刷新模型用量'}))
  await waitFor(()=>expect(mocks.yunshu).toHaveBeenCalledTimes(2))
})

it('isolates rapid period switches and ignores a late prior-period result', async () => {
  let resolve!: (value: AdminYunshuModelUsage) => void
  mocks.yunshu.mockImplementation((period) => period==='today' ? new Promise(accept=>{resolve=accept}) : Promise.resolve(fixture(period)))
  const view=mount()
  await waitFor(()=>expect(mocks.yunshu).toHaveBeenCalledTimes(1))
  view.rerender(<QueryClientProvider client={client}><MemoryRouter><AdminYunshuModelUsage period="month" /></MemoryRouter></QueryClientProvider>)
  await screen.findAllByText('gateway-month')
  await act(async()=>{resolve(fixture('today'))})
  expect(screen.queryByText('gateway-today')).toBeNull()
  expect(screen.getAllByText('gateway-month')).toHaveLength(2)
})

it.each(['unconfigured','error','stale'] as const)('renders %s without converting missing or old data to fresh zeros', async state => {
  mocks.yunshu.mockResolvedValue({...fixture(),state,message:'',observedAt:state==='stale'?fixture().observedAt:null,models:state==='stale'?fixture().models:[]})
  mount()
  expect(await screen.findByText({unconfigured:'尚未配置云枢管理读取凭据。',error:'云枢模型用量暂不可用。',stale:'更新失败，以下保留上次成功快照。'}[state])).toBeTruthy()
  if(state!=='stale') expect(screen.queryByRole('table')).toBeNull()
})

it.each(['error','stale'] as const)('shows the server cooldown message for %s while identifying an old snapshot', async state => {
  const message='云枢读取已限流，预计 20 分钟后恢复，请等待后自动更新。'
  mocks.yunshu.mockResolvedValue({...fixture(),state,message,observedAt:state==='stale'?fixture().observedAt:null,models:state==='stale'?fixture().models:[]})
  mount()
  const alert=await screen.findByRole('alert')
  expect(alert.textContent).toContain(message)
  expect(alert.textContent).not.toContain('请刷新重试')
  if(state==='stale') {
    expect(alert.textContent).toContain('以下保留上次成功快照。')
    expect(screen.getByRole('table')).toBeTruthy()
  }
})

it('uses the network fallback when no business response is received', async () => {
  mocks.yunshu.mockRejectedValue(new Error('synthetic-secret-error'))
  mount()
  expect(await screen.findByText('云枢模型用量读取失败，请刷新重试。')).toBeTruthy()
  expect(screen.queryByText('synthetic-secret-error')).toBeNull()
})

it('keeps a successful snapshot visible after a refresh transport error with no automatic retry', async () => {
  mocks.yunshu.mockResolvedValueOnce(fixture()).mockRejectedValue(new Error('synthetic-sensitive-upstream-error'))
  mount(); await screen.findByRole('table')
  fireEvent.click(screen.getByRole('button',{name:'刷新模型用量'}))
  expect(await screen.findByText('更新失败，以下保留上次成功快照。')).toBeTruthy()
  expect(screen.getByRole('table')).toBeTruthy()
  expect(mocks.yunshu).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('synthetic-sensitive-upstream-error')).toBeNull()
})

it('labels empty and incomplete pagination without inventing a zero-valued model', async () => {
  mocks.yunshu.mockResolvedValue({...fixture(),models:[],paginationComplete:false})
  mount()
  expect(await screen.findByText('该范围暂无云枢模型用量记录。')).toBeTruthy()
  expect(screen.getByText('分页未完成')).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

it('leaves total unknown when either Token component is missing', async () => {
  const data=fixture(); data.models[0].requestTokens=null
  mocks.yunshu.mockResolvedValue(data)
  mount()
  const table=await screen.findByRole('table')
  const cells=within(table).getAllByRole('cell').map(cell=>cell.textContent)
  expect(cells.slice(1,4)).toEqual(['—','20','—'])
})

it('does not wait for a failed local usage query and stops external polling after leaving the usage tab', async () => {
  mocks.local.mockRejectedValue(new Error('local unavailable'))
  mount(<AdminTokenManagementPage />)
  expect(await screen.findByRole('table')).toBeTruthy()
  expect(await screen.findByText('加载失败，请刷新重试。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'调用记录',exact:true}))
  expect(screen.queryByRole('region',{name:'云枢模型用量'})).toBeNull()
  expect(client.getQueryCache().find({queryKey:['admin','yunshu-model-usage','today']})?.getObserversCount()).toBe(0)
})

it('polls every minute only while the document is visible and focused', async () => {
  vi.useFakeTimers()
  let focused=true
  vi.spyOn(document,'hasFocus').mockImplementation(()=>focused)
  mount()
  await act(async()=>{await vi.advanceTimersByTimeAsync(1)})
  expect(mocks.yunshu).toHaveBeenCalledTimes(1)
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(mocks.yunshu).toHaveBeenCalledTimes(2)
  focused=false
  act(()=>{fireEvent(window,new Event('blur'))})
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000)})
  expect(mocks.yunshu).toHaveBeenCalledTimes(2)
  focused=true
  act(()=>{fireEvent(window,new Event('focus'))})
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(mocks.yunshu).toHaveBeenCalledTimes(3)
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
  act(()=>{fireEvent(document,new Event('visibilitychange'))})
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000)})
  expect(mocks.yunshu).toHaveBeenCalledTimes(3)
})
