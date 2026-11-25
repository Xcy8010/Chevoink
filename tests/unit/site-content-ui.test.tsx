// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SiteAnnouncements, SiteInformation } from '../../src/features/site-content/public'
import { dismissalIsActive, dismissalKey } from '../../src/features/site-content/public-api'
import { DOCS, getAccountDocs } from '../../src/features/account/docs-content'
import type { AnnouncementInbox, PublicSiteContent, ReadAnnouncementsRequest } from '../../shared/contracts/site-content'
import AnnouncementBell from '../../src/features/site-content/AnnouncementBell'
import { useShellStore } from '../../src/store/useShellStore'
import { mockAnimationSupport } from '../helpers/test-native-dialog'
const mocks=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
function data():PublicSiteContent {
  const now=Date.now()
  return {serverNow:new Date(now).toISOString(),nextBoundaryAt:null,settings:null,help:{},legal:{terms:null,privacy:null,registrationAvailable:false},announcements:[{id:'notice',contentVersion:1,title:'服务通知',body:'正文第一版',scope:'both',startsAt:new Date(now-60000).toISOString(),endsAt:new Date(now+600000).toISOString(),dismissal:{mode:'version'}}]}
}
function mount(element:React.ReactNode) {const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);return client}
const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal')
const originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close')
beforeEach(()=>{vi.useRealTimers();vi.clearAllMocks();sessionStorage.clear();localStorage.clear();focusManager.setFocused(true)
 useShellStore.setState({ authStatus: 'guest', sessionUser: null })
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:vi.fn(function(this:HTMLDialogElement){this.setAttribute('open','')})})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:vi.fn(function(this:HTMLDialogElement){this.removeAttribute('open')})})
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks()
 if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal')
 if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,'close')
})
function signedInAnnouncements(withOlder = false) {
  useShellStore.setState({
    authStatus: 'authenticated', sessionUser: {
      id: 'author', nickname: '作者', avatarUrl: null, email: null, phone: null, passwordConfigured: false,
      followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0, unreadNotificationCount: 0,
      createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
    },
  })
  const site = data()
  site.announcements[0].versionId = 'notice-v1'
  if (withOlder) site.announcements.push({
    ...site.announcements[0], id: 'older', versionId: 'older-v1', title: '较早公告',
  })
  const inbox: AnnouncementInbox = { viewerId: 'author', serverNow: site.serverNow, nextBoundaryAt: null, items: site.announcements.map(item => ({
    id: item.id, contentVersion: item.contentVersion, versionId: item.versionId!, title: item.title,
    body: item.body, publishedAt: item.startsAt, unread: true,
  })) }
  const markRead = vi.fn((input: ReadAnnouncementsRequest) => {
    const items = inbox.items.filter(item => item.unread && input.action === 'one' && item.versionId === input.versionId)
    for (const item of items) item.unread = false
    return { readVersionIds: items.map(item => item.versionId) }
  })
  const respond = async (url: string, init?: RequestInit) => url.endsWith('/read')
    ? markRead(JSON.parse(String(init?.body)))
    : structuredClone(url.endsWith('/announcements') ? inbox : site)
  mocks.request.mockImplementation(respond)
  return { site, inbox, markRead, respond }
}

function mountStudioAnnouncements() {
  return mount(<><SiteAnnouncements scope="studio" /><AnnouncementBell placement="studio" /></>)
}

it('automatically opens after workspace readiness and marks only the displayed version read', async ({ onTestFinished }) => {
  onTestFinished(mockAnimationSupport())
  const { inbox, markRead } = signedInAnnouncements(true)
  const view = render(<QueryClientProvider client={new QueryClient()}><SiteAnnouncements scope="studio" ready={false}/></QueryClientProvider>)
  await waitFor(() => expect(mocks.request).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(markRead).not.toHaveBeenCalled()
  view.unmount()
  mountStudioAnnouncements()
  const dialog = await screen.findByRole('dialog', { name: '服务通知' })
  expect(within(dialog).getByAltText('启创墨域 Chevoink 最新公告')).toBeTruthy()
  expect(dialog.querySelector('time')?.dateTime).toBe(inbox.items[0].publishedAt)
  expect(markRead).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  expect(dialog.dataset.phase).toBe('closing')
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(markRead).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(markRead).toHaveBeenCalledExactlyOnceWith({ viewerId: 'author', action: 'one', versionId: 'notice-v1' }))
  expect(inbox.items[1].unread).toBe(true)
  expect(screen.getByRole('button', { name: '未读通知' })).toBeTruthy()
})

it('waits for the inbox before choosing a notice and skips a version already read elsewhere', async () => {
  const { inbox, respond, markRead } = signedInAnnouncements(true)
  inbox.items[0].unread = false
  let release: (() => void) | undefined
  mocks.request.mockImplementationOnce(respond).mockImplementationOnce((url: string) => new Promise(resolve => {
    release = () => resolve(respond(url))
  })).mockImplementation(respond)
  mountStudioAnnouncements()
  await waitFor(() => expect(release).toBeDefined())
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => release!())
  const dialog = await screen.findByRole('dialog', { name: '较早公告' })
  expect(within(dialog).getByAltText('启创墨域 Chevoink 公告')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(markRead).toHaveBeenCalledExactlyOnceWith({ viewerId: 'author', action: 'one', versionId: 'older-v1' }))
})

it('clears the last unread indicator on dismissal and restores it if the receipt fails', async () => {
  const { respond } = signedInAnnouncements()
  let rejectReceipt: ((reason: Error) => void) | undefined
  mocks.request.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/read')
    ? new Promise((_resolve, reject) => { rejectReceipt = reject })
    : respond(url, init))
  mountStudioAnnouncements()
  const notice = await screen.findByRole('dialog', { name: '服务通知' })
  expect(screen.getByRole('button', { name: '未读通知' })).toBeTruthy()
  fireEvent.click(within(notice).getByRole('button', { name: '关闭' }))
  const bell = await screen.findByRole('button', { name: '通知中心' })
  expect(bell.querySelector('.site-announcement-bell-dot')).toBeNull()
  await act(async () => rejectReceipt!(new Error('offline')))
  expect(await screen.findByRole('button', { name: '未读通知' })).toBeTruthy()
})

it('remembers a closed version but presents newly published content', async () => {
  const current = data()
  mocks.request.mockResolvedValue(current)
  const client = mount(<SiteAnnouncements scope="studio" />)
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(localStorage.getItem('site-announcement-dismissals')).toContain(dismissalKey('notice', 1))
  const next = { ...current, announcements: [{ ...current.announcements[0], contentVersion: 2, body: '正文第二版' }] }
  await act(async () => client.setQueryData(['site-content', 'public'], next))
  expect(within(await screen.findByRole('dialog')).getByText('正文第二版')).toBeTruthy()
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
it('supports an unlimited publication and Escape, then restores focus to the workspace', async () => {
  const current = data()
  current.announcements[0].endsAt = null
  mocks.request.mockResolvedValue(current)
  mount(<><button data-studio-content-focus>创作内容</button><SiteAnnouncements scope="studio" /></>)
  const dialog = await screen.findByRole('dialog')
  expect(document.activeElement).toBe(dialog)
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '创作内容' }))
})
it('removes an open modal when the published version expires without opening another notice',async()=>{
 const current=data();mocks.request.mockResolvedValue(current);const client=mount(<SiteAnnouncements scope="studio"/>)
 expect(await screen.findByRole('dialog')).toBeTruthy()
 const now=Date.now()
 await act(async()=>client.setQueryData(['site-content','public'],{...current,serverNow:new Date(now).toISOString(),announcements:[{...current.announcements[0],endsAt:new Date(now-1).toISOString()}]}))
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
 expect(screen.queryByLabelText('站点公告')).toBeNull()
 expect(document.body.style.overflow).toBe('')
})
it('persists a TTL close across remounts and makes the exact expiry boundary visible again',async()=>{
 const start=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(start),current=data()
 current.announcements[0].dismissal={mode:'ttl',seconds:60};mocks.request.mockResolvedValue(current)
 mount(<SiteAnnouncements scope="studio"/>);fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'关闭'}))
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
 expect(localStorage.getItem('site-announcement-dismissals')).toContain('notice:1');cleanup()
 clock.mockReturnValue(start+59999);mocks.request.mockResolvedValue({...current,serverNow:new Date(start+59999).toISOString()})
 const client=mount(<SiteAnnouncements scope="studio"/>);await waitFor(()=>expect(client.getQueryData(['site-content','public'])).toBeDefined())
 expect(screen.queryByRole('dialog')).toBeNull();cleanup()
 clock.mockReturnValue(start+60000);mocks.request.mockResolvedValue({...current,serverNow:new Date(start+60000).toISOString()})
 mount(<SiteAnnouncements scope="studio"/>);expect(await screen.findByRole('dialog')).toBeTruthy()
})
it('keeps a close effective in the current view even when browser storage is unavailable',async()=>{
 mocks.request.mockResolvedValue(data());mount(<SiteAnnouncements scope="home"/>)
 const close=await screen.findByRole('button',{name:'关闭公告：服务通知'})
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('storage unavailable')})
 fireEvent.click(close);expect(screen.queryByLabelText('站点公告')).toBeNull()
})

it('cycles Tab inside the centered dialog without reaching background controls',async()=>{
  mocks.request.mockResolvedValue(data())
  mount(<SiteAnnouncements scope="home"/>)
  fireEvent.click(await screen.findByRole('button',{name:'打开公告：服务通知'}))
  const close=screen.getByRole('button',{name:'关闭公告弹窗'}),dismiss=screen.getByRole('button',{name:'关闭本条公告'})
  dismiss.focus();fireEvent.keyDown(dismiss,{key:'Tab'})
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close,{key:'Tab',shiftKey:true})
  expect(document.activeElement).toBe(dismiss)
})
