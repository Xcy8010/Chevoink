// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SiteAnnouncements, SiteInformation } from '../../src/features/site-content/public'
import { dismissalIsActive, dismissalKey } from '../../src/features/site-content/public-api'
import { DOCS, getAccountDocs } from '../../src/features/account/docs-content'
import type { PublicSiteContent } from '../../shared/contracts/site-content'
const mocks=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
function data():PublicSiteContent {
  const now=Date.now()
  return {serverNow:new Date(now).toISOString(),nextBoundaryAt:null,settings:null,help:{},legal:{terms:null,privacy:null,registrationAvailable:false},announcements:[{id:'notice',contentVersion:1,title:'服务通知',body:'正文第一版',scope:'both',startsAt:new Date(now-60000).toISOString(),endsAt:new Date(now+600000).toISOString(),dismissal:{mode:'version'}}]}
}
function mount(element:React.ReactNode) {const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);return client}
beforeEach(()=>{vi.useRealTimers();vi.clearAllMocks();sessionStorage.clear();localStorage.clear();focusManager.setFocused(true)})
afterEach(()=>{cleanup();vi.useRealTimers()})
it('uses announcement id and content version for dismissal and shows a newly published version',async()=>{
  const current=data();mocks.request.mockResolvedValue(current)
  const client=mount(<SiteAnnouncements scope="studio"/>)
  await screen.findByText('正文第一版')
  fireEvent.click(screen.getByRole('button',{name:'关闭公告：服务通知'}))
  expect(screen.queryByText('正文第一版')).toBeNull()
  const next={...current,announcements:[{...current.announcements[0],contentVersion:2,body:'正文第二版'}]}
  mocks.request.mockResolvedValue(next)
  await act(async()=>{client.setQueryData(['site-content','public'],next)})
  expect(await screen.findByText('正文第二版')).toBeTruthy()
  expect(dismissalKey('notice',1)).not.toBe(dismissalKey('notice',2))
})
it('honors scope and expiration while keeping a failed public fetch non-blocking',async()=>{
  const current=data();current.announcements[0].scope='home';mocks.request.mockResolvedValue(current)
  mount(<SiteAnnouncements scope="studio"/>)
  await act(async()=>{await Promise.resolve()})
  expect(screen.queryByText('服务通知')).toBeNull()
  cleanup();mocks.request.mockRejectedValue(new Error('offline'))
  mount(<SiteAnnouncements scope="studio"/>)
  await act(async()=>{await Promise.resolve()})
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('alert')).toBeNull()
})
it('keeps session dismissals out of persistent storage and honors TTL end exclusively',async()=>{
  const current=data();current.announcements[0].dismissal={mode:'session'};mocks.request.mockResolvedValue(current)
  mount(<SiteAnnouncements scope="home"/>);await screen.findByText('服务通知')
  fireEvent.click(screen.getByRole('button',{name:'关闭公告：服务通知'}))
  expect(sessionStorage.getItem('site-announcement-dismissals')).toContain('notice:1')
  expect(localStorage.getItem('site-announcement-dismissals')).toBeNull()
  expect(dismissalIsActive(1000,{mode:'ttl',seconds:60},60999)).toBe(true)
  expect(dismissalIsActive(1000,{mode:'ttl',seconds:60},61000)).toBe(false)
})
it('refreshes at the next server boundary and again on focus',async()=>{
  vi.useFakeTimers();const current=data();current.nextBoundaryAt=new Date(Date.now()+1000).toISOString();mocks.request.mockResolvedValue(current)
  await act(async()=>{mount(<SiteAnnouncements scope="home"/>);await Promise.resolve()})
  const initialCalls=mocks.request.mock.calls.length
  await act(async()=>{await vi.advanceTimersByTimeAsync(1200)})
  expect(mocks.request.mock.calls.length).toBeGreaterThan(initialCalls)
  const boundaryCalls=mocks.request.mock.calls.length
  await act(async()=>{focusManager.setFocused(false);focusManager.setFocused(true);await Promise.resolve()})
  expect(mocks.request.mock.calls.length).toBeGreaterThan(boundaryCalls)
})
it('shows configured public identity, navigation, docs and a real contact link',async()=>{
  const current=data();current.settings={name:'配置站点',logoUrl:'/logo.png',about:'关于文字',footer:'页脚文字',docsLabel:'使用文档',contact:{label:'联系支持',url:'https://example.com/support',details:'工作日联系支持'},navigation:[{label:'发现作品',url:'/discover'}]};mocks.request.mockResolvedValue(current)
  mount(<SiteInformation/>);await screen.findByText('配置站点')
  expect(screen.getByRole('link',{name:'联系支持'}).getAttribute('href')).toBe('https://example.com/support')
  expect(screen.getByRole('link',{name:'使用文档'}).getAttribute('href')).toBe('/account/docs')
  expect(screen.getByRole('link',{name:'发现作品'}).getAttribute('href')).toBe('/discover')
})
it('reuses help keys/groups/section identity while preserving current policy-derived facts',()=>{
  const original=DOCS.find(doc=>doc.key==='quick-start')!
  const override={title:'新帮助标题',summary:'新帮助简介',sections:original.sections.map(section=>({...section,paragraphs:['管理员编辑的段落']}))}
  const docs=getAccountDocs(false,{'quick-start':override})
  const doc=docs.find(item=>item.key==='quick-start')!
  expect(doc).toMatchObject({key:original.key,group:original.group,title:'新帮助标题'})
  expect(doc.sections.map(section=>section.id)).toEqual(original.sections.map(section=>section.id))
  expect(doc.sections.find(section=>section.id==='register')!.paragraphs!.join('')).toContain('免费版套餐')
  expect(doc.sections.find(section=>section.id==='first-chapter')!.paragraphs).toEqual(['管理员编辑的段落'])
  expect(docs.find(item=>item.key==='credits')!.sections.some(section=>section.id==='reset')).toBe(false)
})
it('keeps a server-resolved unlimited announcement visible and preserves per-version dismissal',async()=>{
 const current=data();current.announcements[0].endsAt=null;mocks.request.mockResolvedValue(current)
 mount(<SiteAnnouncements scope="studio"/>);await screen.findByText('正文第一版')
 fireEvent.click(screen.getByRole('button',{name:'关闭公告：服务通知'}))
 expect(screen.queryByText('正文第一版')).toBeNull()
})