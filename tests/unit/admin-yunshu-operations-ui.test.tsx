// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { AdminYunshuOperations as Payload, AdminYunshuOperationsQuery } from '../../shared/contracts/admin-yunshu-usage.js'
import { adminYunshuOperationsFixture as fixture } from '../fixtures/admin-yunshu-operations'
const read=vi.hoisted(()=>vi.fn())
vi.mock('../../src/features/admin/api',()=>({getAdminYunshuOperations:read}))
import AdminYunshuOperations from '../../src/features/admin/components/AdminYunshuOperations'
let client: QueryClient
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});read.mockImplementation(async query=>fixture(query));vi.spyOn(document,'hasFocus').mockReturnValue(true)})
afterEach(()=>{cleanup();client.clear();vi.restoreAllMocks();vi.useRealTimers()})
const element=(view:AdminYunshuOperationsQuery['view'],period:'today'|'month'='today')=><QueryClientProvider client={client}><MemoryRouter><AdminYunshuOperations key={`${view}:${period}`} view={view} period={period}/></MemoryRouter></QueryClientProvider>

it('automatically reads records, pages and filters without inventing local task identity',async()=>{
  render(element('records'))
  const table=await screen.findByRole('table',{name:'云枢调用明细'})
  expect(read).toHaveBeenCalledWith({period:'today',view:'records',page:1,pageSize:20,kind:'all'},expect.any(AbortSignal))
  expect(within(table).getByText('100 / —')).toBeTruthy()
  expect(within(table).getByText('未知')).toBeTruthy()
  expect(screen.queryByText('Run ID')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'下一页'}))
  await waitFor(()=>expect(read).toHaveBeenLastCalledWith(expect.objectContaining({page:2}),expect.any(AbortSignal)))
  await screen.findAllByText('gateway-today-2')
  fireEvent.change(screen.getByLabelText('云枢记录类型'),{target:{value:'error'}})
  await waitFor(()=>expect(read).toHaveBeenLastCalledWith(expect.objectContaining({page:1,kind:'error'}),expect.any(AbortSignal)))
  expect(screen.getByRole('option',{name:'错误日志'})).toBeTruthy()
})

it('does not let a late old-period response replace a new period',async()=>{
  let resolve!:(value:Payload)=>void
  read.mockImplementation(query=>query.period==='today'?new Promise(accept=>{resolve=accept}):Promise.resolve(fixture(query)))
  const view=render(element('records'))
  await waitFor(()=>expect(read).toHaveBeenCalledOnce())
  view.rerender(element('records','month'))
  await screen.findAllByText('gateway-month-1')
  await act(async()=>resolve(fixture()))
  expect(screen.queryByText('gateway-today-1')).toBeNull()
})

it('shows actual status-interface access and passive health samples with unknown outcomes intact',async()=>{
  render(element('health'))
  expect(await screen.findByText('状态接口可读取')).toBeTruthy()
  expect(screen.getByText(/不代表所有模型可用/)).toBeTruthy()
  expect(screen.getByText(/不代表实时主动探测/)).toBeTruthy()
  expect(screen.getByText('流式结果未知')).toBeTruthy()
  expect(screen.getByText('1,400 ms')).toBeTruthy()
  expect(screen.getByText('9,200 ms')).toBeTruthy()
  expect(screen.queryByText('100%')).toBeNull()
  expect(read).toHaveBeenCalledWith(expect.objectContaining({view:'health'}),expect.any(AbortSignal))
})

it('keeps cost decimal precision, negative net amounts and management-account scope',async()=>{
  render(element('cost'))
  expect(await screen.findByText('24,691,357,802,469.13578 USD')).toBeTruthy()
  expect(screen.getByText('-0.00002 USD')).toBeTruthy()
  expect(screen.getByText('18,014,398,509,481.986 USD')).toBeTruthy()
  expect(screen.getByRole('heading',{name:'云枢管理账号余额'})).toBeTruthy()
  expect(screen.getByText(/管理账号范围，与上方所选期间及平台令牌范围不同/)).toBeTruthy()
  expect(screen.queryByText('Credits')).toBeNull()
})

it('keeps raw precise quotas when currency conversion and balance fail independently',async()=>{
  const data=fixture();data.cost.display={...data.cost.display,state:'error',message:'单位读取暂不可用。',deduction:null,refund:null,net:null};data.balance={...data.balance,state:'error',message:'余额读取暂不可用。',remainingQuota:null,usedQuota:null,displayRemaining:null,displayUsed:null}
  read.mockResolvedValue(data)
  render(element('cost'))
  expect(await screen.findByText('12,345,678,901,234,567,890 网关额度单位（换算未知）')).toBeTruthy()
  expect(screen.getByText('单位读取暂不可用。')).toBeTruthy()
  expect(screen.getByText('余额读取暂不可用。')).toBeTruthy()
  expect(screen.getByText('扣费待核 1 条 · 退款待核 0 条 · 读取失败')).toBeTruthy()
})

it('uses gateway units for TOKENS display and never calls them actual Token usage',async()=>{
  const data=fixture();data.cost.display={...data.cost.display,type:'TOKENS',deduction:'12345678901234567890'};read.mockResolvedValue(data)
  render(element('cost'))
  expect(await screen.findByText('12,345,678,901,234,567,890 网关额度单位')).toBeTruthy()
  expect(screen.queryByText('12,345,678,901,234,567,890 Token')).toBeNull()
})

it('preserves a successful snapshot and the server cooldown message without encouraging retries',async()=>{
  const data={...fixture(),state:'stale' as const,message:'云枢已限流，请等待 20 分钟后自动更新。'}
  read.mockResolvedValue(data)
  render(element('records'))
  const alert=await screen.findByRole('alert')
  expect(alert.textContent).toContain(data.message)
  expect(alert.textContent).toContain('以下保留上次成功快照')
  expect(alert.textContent).not.toContain('刷新重试')
  expect(screen.getByRole('table')).toBeTruthy()
})

it('keeps an old snapshot after a transport error without rendering private exception text',async()=>{
  read.mockResolvedValueOnce(fixture()).mockRejectedValue(new Error('synthetic-sensitive'))
  render(element('records'));await screen.findByRole('table')
  fireEvent.click(screen.getByRole('button',{name:'刷新云枢数据'}))
  expect(await screen.findByText('云枢数据暂不可用。 以下保留上次成功快照。')).toBeTruthy()
  expect(screen.getByRole('table')).toBeTruthy()
  expect(screen.queryByText('synthetic-sensitive')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['cost','records'] as const)('clears prior account values after a successful safe scope-change error response in %s',async view=>{
  const cleared=fixture()
  cleared.state='error';cleared.observedAt=null;cleared.message='云枢读取范围已变化，请重新核实配置。'
  cleared.sources={configured:1,verified:0,unresolved:1}
  cleared.records={...cleared.records,items:[],total:0,totalPages:1,totalObserved:0,hasMore:false}
  cleared.health={observation:'no_samples',consumeCount:0,errorCount:0,refundCount:0,streamSuccessCount:0,streamErrorCount:0,unknownOutcomeCount:0,durationSamples:0,p50Ms:null,p95Ms:null,lastSampleAt:null}
  cleared.cost={deductionQuota:null,refundQuota:null,netQuota:null,unknownDeductionCount:0,unknownRefundCount:0,display:{state:'error',observedAt:null,message:'换算数据已清除。',quotaPerUnit:null,type:null,rate:null,symbol:null,deduction:null,refund:null,net:null}}
  cleared.balance={scope:'management_account',state:'error',observedAt:null,message:'原账号余额已清除。',remainingQuota:null,usedQuota:null,displayRemaining:null,displayUsed:null}
  read.mockResolvedValueOnce(fixture()).mockResolvedValueOnce(cleared)
  render(element(view))
  if(view==='cost') await screen.findByText('18,014,398,509,481.986 USD')
  else await screen.findByRole('table')
  fireEvent.click(screen.getByRole('button',{name:'刷新云枢数据'}))
  expect(await screen.findByText(cleared.message)).toBeTruthy()
  expect(screen.queryByText('18,014,398,509,481.986 USD')).toBeNull()
  expect(screen.queryByText('24,691,357,802,469.13578 USD')).toBeNull()
  expect(screen.queryByText('-0.00002 USD')).toBeNull()
  expect(screen.queryByText('gateway-today-1')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText(/以下保留上次成功快照/)).toBeNull()
})

it('renders signed management balances precisely in both converted and raw quota displays',async()=>{
  const data=fixture();data.balance={...data.balance,remainingQuota:'-617283945',displayRemaining:'-1234.56789'}
  const unconverted={...data,cost:{...data.cost,display:{...data.cost.display,state:'error' as const,deduction:null,refund:null,net:null}},balance:{...data.balance,displayRemaining:null,displayUsed:null}}
  read.mockResolvedValueOnce(data).mockResolvedValueOnce(unconverted)
  render(element('cost'))
  expect(await screen.findByText('-1,234.56789 USD')).toBeTruthy()
  expect(screen.getByRole('heading',{name:'云枢管理账号余额'}).closest('section')?.textContent).not.toContain('读取失败')
  fireEvent.click(screen.getByRole('button',{name:'刷新云枢数据'}))
  expect(await screen.findByText('-617,283,945 网关额度单位（换算未知）')).toBeTruthy()
  expect(screen.getByRole('heading',{name:'云枢管理账号余额'}).closest('section')?.textContent).not.toContain('读取失败')
})

it('polls only while visible and focused and releases its query on unmount',async()=>{
  vi.useFakeTimers();let focused=true;vi.spyOn(document,'hasFocus').mockImplementation(()=>focused)
  const view=render(element('health'))
  await act(async()=>{await vi.advanceTimersByTimeAsync(1)})
  expect(read).toHaveBeenCalledOnce()
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(read).toHaveBeenCalledTimes(2)
  focused=false;act(()=>fireEvent(window,new Event('blur')))
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000)})
  expect(read).toHaveBeenCalledTimes(2)
  view.unmount()
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000)})
  expect(read).toHaveBeenCalledTimes(2)
})
