import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '../../src/components/ui/Toast'
import AdminLayout from '../../src/features/admin/AdminLayout'
import AdminDashboardPage from '../../src/features/admin/pages/AdminDashboardPage'
import AdminModelsPage from '../../src/features/admin/pages/AdminModelsPage'
import AdminUsersPage from '../../src/features/admin/pages/AdminUsersPage'
import AdminNovelsPage from '../../src/features/admin/pages/AdminNovelsPage'
import AdminPostsPage from '../../src/features/admin/pages/AdminPostsPage'
import AdminCommentsPage from '../../src/features/admin/pages/AdminCommentsPage'
import AdminMessagesPage from '../../src/features/admin/pages/AdminMessagesPage'
import AdminFeedbackPage from '../../src/features/admin/pages/AdminFeedbackPage'
import AdminCreditsManagementPage from '../../src/features/admin/pages/AdminCreditsManagementPage'
import AdminTokenManagementPage from '../../src/features/admin/pages/AdminTokenManagementPage'
import AdminCreationRecordsPage from '../../src/features/admin/pages/AdminCreationRecordsPage'
import AdminCraftLibraryPage from '../../src/features/admin/pages/AdminCraftLibraryPage'
import AdminAgentEvalsPage from '../../src/features/admin/pages/AdminAgentEvalsPage'
import AdminLogsPage from '../../src/features/admin/pages/AdminLogsPage'
import AdminSettingsPage from '../../src/features/admin/pages/AdminSettingsPage'
import '../../src/index.css'
const now = '2026-11-01T12:00:00.000Z'
const user = { id: 'public-fixture-user', nickname: '示例创作者', avatarUrl: null, phone: null, email: null, role: 'author', bannedAt: null, createdAt: now, lastActiveAt: now, isOnline: false, novelCount: 2, postCount: 1, followerCount: 0 }
const models = [
 ['speed','轻量','text','relay-text'],['builtin_0123456789abcdef','标准','text','relay-standard'],['builtin_1111111111111111','性能','text','relay-performance'],['tool_search','联网搜索 Search','web_search','deepseek-search'],['tool_fetch','网页抓取 Fetch','web_fetch','deepseek-fetch'],['tool_image','图片生成','image_generation','image-relay'],['tool_vision','图片理解','vision','vision-relay'],
].map(([tier,displayName,modelKind,modelName],i)=>({ id:`model-${i}`,tier,displayName,modelKind,modelName,sortOrder:i,provider:'演示中转',baseUrl:modelKind==='web_search'?'https://relay.example.com/v1/tools/search':modelKind==='web_fetch'?'https://relay.example.com/v1/tools/fetch':'https://relay.example.com/v1',webToolProtocol:modelKind.startsWith('web_')?'deepseek':undefined,multiplier:1,enabled:i!==2,selectable:modelKind==='text',isDefault:i===0,apiKeyConfigured:i!==2,configurationReady:i!==2,requestCount:12,requestTokens:12000,responseTokens:4000,reasoningEfforts:['high'],defaultReasoningEffort:'high',visionEnabled:modelKind==='vision',contextWindowTokens:128000,updatedAt:now,revision:1,archivedAt:null,archiveReason:null,routes:[],weightedRoutes:{primaryWeight:100,candidates:[]} }))
const params = new URLSearchParams(location.search)
if(params.get('theme')==='dark') document.documentElement.classList.add('dark')
const pagination = { page:1,pageSize:10,total:1,totalPages:1 }
const empty = { items:[],pagination:{...pagination,total:0} }
window.fetch = async (input, init) => {
 const url=new URL(typeof input==='string'?input:input instanceof Request?input.url:input.href,location.origin)
 const method=init?.method??'GET'
 const model=models.find(item=>url.pathname.startsWith('/api/admin/models/'+item.id+'/'))
 if(model&&method==='POST'&&url.pathname.endsWith('/diagnostics')) {
  const body=JSON.parse(String(init?.body??'{}'))
  return Response.json({success:true,data:{id:'synthetic-diagnostic',requestKey:body.requestKey,modelConfigId:model.id,configRevision:String(model.revision),modelName:model.modelName,provider:model.provider,modelKind:model.modelKind,mode:body.mode,status:'configuration_passed',stale:false,createdAt:now,finishedAt:now,failure:null,checks:[{field:'baseUrl',passed:true,message:'公开合成端点通过静态检查，未请求上游。'}],metrics:{responseHeadersMs:null,firstEventMs:null,firstThinkingMs:null,firstTextMs:null,totalMs:null,outputTokens:null,tokensPerSecond:null},fee:{identity:'synthetic-platform-only',owner:'platform',status:'not_requested',currency:'CNY',amountMicros:null,maximumMicros:null},livePolicy:{enabled:false,maximumCostMicros:null,blockedReason:'真实请求尚未开放。'}}})
 }
 if (!url.pathname.startsWith('/api/admin')) throw Error('Preview blocks all non-admin requests')
 if (init?.method && init.method!=='GET') return Response.json({success:false,error:{code:'PREVIEW_READ_ONLY',message:'合成预览仅用于只读审阅。'}},{status:409})
 let data: unknown = empty
 if(url.pathname==='/api/admin/me') data={...user,id:'public-fixture-admin',nickname:'演示管理员',role:'admin',isSuperAdmin:true}
 else if(url.pathname==='/api/admin/models') data={models:models.filter(item=>url.searchParams.get('view')==='archived'?item.archivedAt!==null:item.archivedAt===null),trend:[]}
 else if(model&&url.pathname.endsWith('/lifecycle')) data={id:model.id,displayName:model.displayName,revision:model.revision,archivedAt:null,modelKind:model.modelKind,isDefault:model.isDefault,systemRoles:model.id==='model-0'?['speed']:[],impact:{queued:1,running:1,paused:1,historicalCalls:12,assignments:0,queuedRequests:0,goals:0,schedules:0,imports:0},historyAttribution:'tier',candidates:models.filter(item=>item.id!==model.id&&item.modelKind===model.modelKind).map(item=>({id:item.id,displayName:item.displayName,revision:item.revision,modelKind:item.modelKind,eligible:item.enabled,reasons:item.enabled?[]:['服务未启用']})),previewHash:'synthetic-preview-only'}
 else if(url.pathname.startsWith('/api/admin/operations/')) {
  const context={source:'provider_attempts',coverage:['仅公开合成数据，无真实调用或账务'],snapshotAt:now,window:{from:'2026-10-31T16:00:00.000Z',to:'2026-11-01T16:00:00.000Z',timeZone:'UTC+8',boundary:'created_at'}}
  data=url.pathname.endsWith('/health')?{...context,observation:'no_samples',counts:{total:0,success:0,failure:0,pending:0,cancelled:0,unknown:0},lastSampleAt:null,firstTextMs:null,p50Ms:null,p95Ms:null,tokensPerSecond:null}:{...context,...empty}
 }
 else if(url.pathname==='/api/admin/users') data={items:[user],pagination}
 else if(url.pathname==='/api/admin/novels') data={items:[{id:'public-fixture-novel',title:'山海之间：公开合成作品',displayTitle:null,status:'published',visibility:'public',categoryName:'幻想',wordCount:12400,chapterCount:8,commentCount:2,favoriteCount:0,publishedAt:now,updatedAt:now,author:user}],pagination}
 else if(url.pathname==='/api/admin/posts') data={items:[{id:'fixture-post',excerpt:'公开合成讨论：如何建立清晰的人物关系？',author:user,createdAt:now,updatedAt:now,commentCount:3,likeCount:0}],pagination}
 else if(url.pathname==='/api/admin/feedback') data={...empty,counts:{pending:0,accepted:0,ignored:0}}
 else if(url.pathname==='/api/admin/credits') data={pagination:{page:1,pageSize:20,total:1,hasMore:false},snapshotAt:now,summaryScope:'global',summary:{globallyPaused:false,publicBetaEnabled:true,publicBetaRevision:1,users:1,dailyAllowance:0,dailyUsed:0,bonusBalance:0,exhaustedUsers:0},users:[{user,planLabel:'公测版',dailyAllowance:0,dailyUsed:0,dailyRemaining:0,bonusBalance:0,totalRemaining:0,usedPercent:0,resetsAt:now,suspended:false}]}
 else if(url.pathname==='/api/admin/analytics') data={period:url.searchParams.get('period')??'day',from:now,to:now,labels:['2026-11-01 12:00'],metrics:[['users','新增用户',3],['completed','执行完成',8],['failed','执行异常',1],['tools','工具返回',12],['toolSuccess','工具成功',11],['toolFailed','工具未成功',1]].map(([key,label,total])=>({key,label,total,values:[total]})),tools:[],imports:null,cost:{knownCalls:0,unknownCalls:0,estimated:0,models:[]}}
 else if(url.pathname==='/api/admin/token-usage') data={period:'today',periodStartedAt:now,summary:{totalTokens:0,requestTokens:0,responseTokens:0,cacheHitTokens:0,cacheMissTokens:0,cacheObservedTokens:0,users:0,webSearchCalls:0,imageCalls:0},users:[],actions:[],models:[],runs:[],runTurns:[],trend:[]}
 else if(url.pathname==='/api/admin/creation-records') data={items:[],total:0,page:1,pageSize:20,hasMore:false}
 else if(url.pathname==='/api/admin/craft/sources') data={sources:[]}
 else if(url.pathname==='/api/admin/evals/suites') data={suites:[]}
 else if(url.pathname==='/api/admin/agent3/operations') data={research:{queryBudgetViolations:0,builds:0,reuses:0,reuseRate:0,averageSearchesPerBuild:0,averageInputTokensPerBuild:0},prototypes:{completed:0,total:0,completionRate:0},privacy:{analyticsOptOut:0},sharing:{accepted:0}}
 else if(url.pathname==='/api/admin/integrations/status') data={source:'yunshu_read_only',observedAt:now,resources:['model_metadata','usage','gateway_charges','gateway_health'].map(resource=>({resource,state:'blocked',canRead:false,blockingReasons:['未核实只读权限、墨域专属来源及请求标识映射；没有发起外部读取。'],lastAttemptAt:null,lastSuccessAt:null,failureReason:null,snapshot:null,retention:'process_memory'})),mappings:[],system:{applicationName:'启创墨域',releaseVersion:null,releaseVersionSource:'not_available',checkedAt:now,coverage:['仅公开合成预览']},deferred:[]}
 else if(url.pathname==='/api/admin/supplier-balances') data=[]
 return Response.json({success:true,data})
}
const pages: Record<string,React.ReactNode> = {'':<AdminDashboardPage/>,models:<AdminModelsPage/>,users:<AdminUsersPage/>,novels:<AdminNovelsPage/>,posts:<AdminPostsPage/>,comments:<AdminCommentsPage/>,messages:<AdminMessagesPage/>,feedback:<AdminFeedbackPage/>,credits:<AdminCreditsManagementPage/>,tokens:<AdminTokenManagementPage/>, 'creation-records':<AdminCreationRecordsPage/>,craft:<AdminCraftLibraryPage/>,evals:<AdminAgentEvalsPage/>,logs:<AdminLogsPage/>,settings:<AdminSettingsPage/>}
const page=params.get('page')??''; const route='/admin'+(page?'/'+page:'')+(params.get('model')?'?model='+params.get('model'):'')
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}})
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><ToastProvider><MemoryRouter initialEntries={[route]}><Routes>{Object.entries(pages).map(([path,element])=><Route key={path} path={'/admin'+(path?'/'+path:'')} element={<AdminLayout>{element}</AdminLayout>}/>)}</Routes></MemoryRouter></ToastProvider></QueryClientProvider>)
