// @vitest-environment jsdom
import { SiteInformation } from '../../src/features/site-content/public'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AppShell from '../../src/components/layout/AppShell'
import FeedbackDialog from '../../src/features/feedback/components/FeedbackDialog'
import { useShellStore } from '../../src/store/useShellStore'
import type { PublicSiteContent } from '../../shared/contracts/site-content'
const mocks=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
vi.mock('../../src/components/ui/toast-context',()=>({useToast:()=>({error:vi.fn()})}))
vi.mock('../../src/features/search/GlobalSearchBox',()=>({default:()=> <input aria-label="全局搜索"/>}))
vi.mock('../../src/components/layout/QuickCreateSheet',()=>({default:()=>null}))
vi.mock('../../src/components/ui/AppImage',()=>({default:({src,alt}:{src:string;alt:string})=><img src={src} alt={alt}/>}))
vi.mock('../../src/features/community/components/Avatar',()=>({default:()=> <span>头像</span>}))
vi.mock('../../src/features/feedback/feedback-media',()=>({
  FEEDBACK_CAPTURE_IGNORE_ATTR: 'data-feedback-capture-ignore',
  captureViewportScreenshot: async () => null,
  prepareFeedbackImage: vi.fn(),
}))
function data():PublicSiteContent{return{serverNow:new Date().toISOString(),nextBoundaryAt:null,announcements:[],help:{},legal:{terms:null,privacy:null,registrationAvailable:false},settings:{name:'配置后的站点',logoUrl:'https://example.com/published-logo.png',footer:'Footer',about:'About',docsLabel:'Docs',contact:{label:'Support',url:'https://example.com/contact',details:''},navigation:[{label:'精选分类',url:'/discover'},{label:'官方支持',url:'https://example.com/support'}]}}}
function Probe(){const location=useLocation();return <output data-testid="current-route">{location.pathname}</output>}
function mount(content?: React.ReactNode){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/']}><AppShell title="首页" description="页面说明"><Probe/><SiteInformation/>{content}</AppShell></MemoryRouter></QueryClientProvider>);return client}
beforeEach(()=>{vi.clearAllMocks();useShellStore.setState({authStatus:'guest',sessionUser:null,quickCreateOpen:false});vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.spyOn(window,'scrollTo').mockImplementation(()=>{});Object.defineProperty(HTMLElement.prototype,'scrollTo',{configurable:true,value:vi.fn()});mocks.request.mockResolvedValue(data())})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})
it('renders published identity and safe configured links in both actual desktop and mobile header navigation',async()=>{
 mount();await screen.findByRole('img',{name:'配置后的站点 Logo'})
 expect(screen.getByRole('img',{name:'配置后的站点 Logo'}).getAttribute('src')).toBe('https://example.com/published-logo.png')
 const navigations=screen.getAllByRole('navigation',{name:'站点导航'})
 expect(navigations).toHaveLength(2)
 for(const nav of navigations){expect(within(nav).getByRole('link',{name:'精选分类'}).getAttribute('href')).toBe('/discover');const external=within(nav).getByRole('link',{name:'官方支持'});expect(external.getAttribute('href')).toBe('https://example.com/support');expect(external.getAttribute('target')).toBe('_blank');expect(external.getAttribute('rel')).toBe('noopener noreferrer')}
 expect(navigations[1].className).toContain('flex lg:hidden')
 fireEvent.click(within(navigations[0]).getByRole('link',{name:'精选分类'}));expect(screen.getByTestId('current-route').textContent).toBe('/discover')
 expect(screen.getAllByRole('link').some(link=>link.getAttribute('href')==='/messages')).toBe(true)
 expect(screen.queryByText('管理员')).toBeNull()
})
it('updates actual header only from published query data and preserves legacy identity/navigation when no settings are published',async()=>{
 const current=data();current.settings=null;mocks.request.mockResolvedValue(current)
 const client=mount();await act(async()=>{await Promise.resolve()})
 expect(screen.getByRole('img',{name:'启创墨域 Logo'}).getAttribute('src')).toBe('/favicon.png')
 expect(screen.getAllByRole('navigation',{name:'站点导航'}).every(nav=>within(nav).queryByRole('link',{name:'精选分类'})===null)).toBe(true)
 const published=data();published.settings!.name='新发布站点';mocks.request.mockResolvedValue(published)
 await act(async()=>{client.setQueryData(['site-content','public'],published)})
 expect(await screen.findByRole('img',{name:'新发布站点 Logo'})).toBeTruthy()
})
it('uses the same ordered published navigation in header and footer and hides omitted entries',async()=>{
 const client=mount();await screen.findByRole('img',{name:'配置后的站点 Logo'})
 const expected=['精选分类','官方支持']
 for(const nav of screen.getAllByRole('navigation',{name:'站点导航'}))expect(within(nav).getAllByRole('link').map(link=>link.textContent)).toEqual(expected)
 const footer=screen.getByRole('contentinfo');expect(within(footer).getAllByRole('link').slice(0,2).map(link=>link.textContent)).toEqual(expected)
 const hidden=data();hidden.settings!.navigation=[];mocks.request.mockResolvedValue(hidden)
 await act(async()=>{client.setQueryData(['site-content','public'],hidden)})
 await waitFor(()=>expect(screen.queryAllByRole('link',{name:'官方支持'})).toHaveLength(0))
 for(const nav of screen.getAllByRole('navigation',{name:'站点导航'}))expect(within(nav).queryAllByRole('link')).toHaveLength(0)
})

it('puts the configured support link directly below My Creations in both sidebar account menus', async () => {
  useShellStore.setState({ authStatus: 'authenticated', sessionUser: {
    id: 'fixture-author', nickname: '测试作者', avatarUrl: null, email: null, phone: null, passwordConfigured: false,
    followerCount: 0, followingCount: 0, novelCount: 0, postCount: 0, unreadMessageCount: 0, unreadNotificationCount: 0,
    createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
  } })
  mount()
  await screen.findByRole('img', { name: '配置后的站点 Logo' })
  const assertLink = (link: HTMLElement) => {
    expect(link.previousElementSibling?.textContent?.trim()).toBe('我的创作')
    expect(link.getAttribute('href')).toBe('https://example.com/contact')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  }
  assertLink(screen.getByRole('link', { name: '联系客服' }))
  fireEvent.click(screen.getByRole('button', { name: '展开侧边栏' }))
  fireEvent.click(screen.getByRole('button', { name: /测试作者.*继续管理/ }))
  const links = screen.getAllByRole('link', { name: '联系客服' })
  expect(links).toHaveLength(2)
  links.forEach(assertLink)
})

it.each([['bug', '问题反馈'], ['suggestion', '提交建议']] as const)(
  'opens customer support from the %s feedback form without submitting feedback',
  async (kind, title) => {
    mocks.request.mockResolvedValue({ ...data(), settings: null })
    mount(<FeedbackDialog open kind={kind} source="studio-work" onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    const link = screen.getByRole('link', { name: '联系客服' })
    expect(link.getAttribute('href')).toBe('https://work.weixin.qq.com/kfid/kfc79a6e1508b365a61')
    expect(link.getAttribute('target')).toBe('_blank')
    await act(async () => { fireEvent.click(link) })
    expect(mocks.request.mock.calls.some(([url]) => url === '/api/feedback')).toBe(false)
  },
)
