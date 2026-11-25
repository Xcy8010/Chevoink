// Run after npm run build:client: node tests/ui/studio-loading.browser.mjs [dist-directory]
// Requires playwright-core and its Chromium browser, or PLAYWRIGHT_CORE_PATH (module entry) / CHROME_BIN.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessions, studioApi } from '../fixtures/studio-loading-api.mjs'

const dist = resolve(process.argv[2] ?? 'dist')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ? pathToFileURL(resolve(process.env.PLAYWRIGHT_CORE_PATH)).href : 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined })
const page = await browser.newPage({ viewport: {width: 1600, height: 900}, serviceWorkers: 'block', reducedMotion: 'reduce' })
await page.addInitScript(() => {
  // Keep the chapter viewer cold until the test opens it. Normal connections can preload it while idle.
  Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true })
  localStorage.setItem('chevoink-shell', JSON.stringify({state: {fullscreenPromptSeen: true}, version: 0}))
  // B was last closed on its memory tab; its chunk has never been opened in this browser.
  localStorage.setItem('chevoink:studio-work-panel-ui', JSON.stringify({
    'fixture-author:novel-0:session-B': {rightOpen: true, viewer: null, inspectorTab: 'context'},
  }))
})
page.setDefaultTimeout(8000)
const origin = 'http://studio.test'
const requests = []
const historyPages = []
const errors = []
page.on('pageerror', error => errors.push(error.message))
const types = {html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', webp: 'image/webp', png: 'image/png', json: 'application/json'}
let hold
const firstArtifactRead = Promise.withResolvers()
const artifactPath = '/api/agent/sessions/session-A/history/workspace'
await page.route('**/*', async route => {
  const req = route.request()
  const url = new URL(req.url())
  if (url.origin !== origin || req.method() !== 'GET') return route.abort()
  requests.push({path: url.pathname, document: req.isNavigationRequest()})
  if (url.pathname === artifactPath && requests.filter(r => r.path === artifactPath).length === 1) {
    await firstArtifactRead.promise
    return route.fulfill({status: 503, json: {success: false, error: {code: 'TEMPORARILY_UNAVAILABLE'}}})
  }
  if (hold?.matches(url.pathname)) {
    hold.started()
    await hold.resume
  }
  if (url.pathname.startsWith('/api/')) {
    const data = studioApi(url)
    if (url.pathname.endsWith('/messages') && data?.messages) historyPages.push({
      session: url.pathname.split('/').at(-2), runLimit: Number(url.searchParams.get('runLimit')) || null,
      messages: data.messages.length, hasMore: data.pagination?.hasMore ?? false,
    })
    return data === undefined ? route.fulfill({status: 404, json: {success: false, error: {code: 'NO_FIXTURE'}}})
      : route.fulfill({json: {success: true, data}})
  }
  const file = resolve(dist, req.isNavigationRequest() ? 'index.html' : decodeURIComponent(url.pathname.slice(1)))
  assert.ok(file.startsWith(dist + sep))
  const body = await readFile(file).catch(() => null)
  return route.fulfill(body ? {body, contentType: types[extname(file).slice(1)] ?? 'application/octet-stream'} : {status: 404})
})

const workspace = page.locator('.studio-workspace[data-visual-viewport]')
const composer = page.locator('[data-agent-composer-editor]:visible')
const scroll = page.locator('.agent-conversation-scroll:visible')
const inspector = page.locator('[data-studio-panel="workInspector"]')
const button = (name, root = page) => root.getByRole('button', {name, exact: true})
const draft = '未发送的虚构草稿 A'
const chunk = component => path => new RegExp('/' + component + '-[^/]+\\.js$').test(path)
async function settled() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function whilePending(matches, action, verify) {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  hold = {matches, started: entered.resolve, resume: gate.promise}
  let timeout
  try {
    await action()
    await Promise.race([entered.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Expected an uncached request')), 8000) })])
    await verify()
  } finally {
    clearTimeout(timeout)
    hold = undefined
    gate.resolve()
  }
  await settled()
}
async function contentVisible(text) { await scroll.getByText(text, {exact: true}).filter({visible:true}).first().waitFor() }
async function assertComposer(ref, position) {
  assert.equal(await composer.evaluate((el, original) => el === original, ref), true, 'composer was remounted')
  assert.equal(await composer.innerText(), draft)
  assert.equal(await scroll.evaluate(el => el.scrollTop), position, 'conversation scroll jumped')
}
function selectTask(index) {
  return page.getByRole('button', {name: new RegExp('^' + sessions[index].title + '(?:，|$)')}).first().click()
}
async function assertNoPageFallback() {
  assert.equal(await page.evaluate(() => window.studioFallbackFrames), 0, 'whole-page fallback appeared after Studio became interactive')
  assert.equal(requests.filter(r => r.document).length, 1, 'browser document navigated')
}
try {
  const sessionListStarted = Promise.withResolvers()
  const sessionListGate = Promise.withResolvers()
  hold = {matches: pathname => pathname === '/api/agent/sessions', started: sessionListStarted.resolve, resume: sessionListGate.promise}
  await page.goto(origin + '/studio/novel/novel-0?session=session-A&from=regression')
  await sessionListStarted.promise
  await workspace.waitFor()
  const modelChip = page.locator('[aria-label="模型档位"]')
  const modelSkeleton = modelChip.getByRole('status', {name: '正在加载当前模型'})
  await modelSkeleton.waitFor()
  assert.doesNotMatch(await modelChip.innerText(), /极速|极致|标准/, 'model must stay unresolved while session identity is being resolved')
  sessionListGate.resolve()
  hold = undefined
  await workspace.waitFor()
  await page.locator('[aria-label="模型档位"]').getByText('标准', {exact: true}).waitFor()
  assert.equal(await page.getByRole('status', {name: '正在加载当前模型'}).count(), 0, 'fast session configuration should render without an artificial delay')
  await contentVisible('试验任务A合成消息47')
  assert.deepEqual(historyPages.find(page => page.session === 'session-A'), { session: 'session-A', runLimit: 10, messages: 20, hasMore: true },
    'first chat page should return ten complete synthetic runs and preserve a cursor for older history')
  await page.evaluate(() => {
    window.studioFallbackFrames = 0
    window.warmSkillsFallback = null
    const observe = () => {
      if ([...document.querySelectorAll('[aria-label="创作区加载中"], [role="status"].fixed.inset-0')].some(el => el.getClientRects().length)) window.studioFallbackFrames++
      if (window.warmSkillsFallback !== null && document.querySelector('[aria-label="正在打开技能"]')?.checkVisibility()) window.warmSkillsFallback = true
    }
    new MutationObserver(observe).observe(document.body, {attributes: true, childList: true, subtree: true})
    observe()
  })
  const editor = await composer.elementHandle()
  await composer.fill(draft)
  if (await button('展开检查区').isVisible()) await button('展开检查区').click()
  const bottom = await scroll.evaluate(el => el.scrollTop)
  assert.ok(bottom > 700, 'fixture history must scroll')
  await scroll.hover()
  await page.mouse.wheel(0, -640)
  await page.waitForFunction(({node, bottom}) => node.scrollTop < bottom - 100, {node: await scroll.elementHandle(), bottom})
  await settled()
  let position = await scroll.evaluate(el => el.scrollTop)
  assert.ok(position > 0 && position < bottom, 'reader must be in the middle of the conversation')
  const initialStudioRequests = requests.filter(r => r.path.endsWith('/studio')).length
  firstArtifactRead.resolve()
  const partialReadFailure = page.getByRole('status').filter({hasText: '任务资料暂未同步'}).filter({visible:true})
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === artifactPath && response.status() === 200),
  ])
  await page.waitForURL(u => !u.searchParams.has('session') && u.searchParams.get('from') === 'regression')
  assert.equal(await partialReadFailure.count(), 0, 'one transient 503 should recover without showing the task warning')
  await assertComposer(editor, position)
  assert.equal(requests.filter(r => r.path === artifactPath).length, 2, 'one transient 503 should trigger exactly one automatic retry')

  await whilePending(chunk('StudioChapterViewer'), () => inspector.getByText(/甲作品测试章节/).filter({visible:true}).first().click(), async () => {
    await page.getByRole('status', {name: '正在打开章节查看器'}).waitFor()
    await assertComposer(editor, position)
    await assertNoPageFallback()
  })
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(el => el.value === '甲作品测试正文' && el.checkVisibility()))
  await whilePending(chunk('SkillsPanel'), () => button('技能', inspector).click(), async () => {
    await inspector.getByRole('status', {name: '正在打开技能'}).waitFor()
    await assertComposer(editor, position)
    await assertNoPageFallback()
  })
  await inspector.getByText('0/0 已启用').waitFor()
  await button('作品', inspector).click()
  await page.evaluate(() => {window.warmSkillsFallback = false})
  await button('技能', inspector).click()
  await inspector.getByText('0/0 已启用').waitFor()
  await settled()
  await assertComposer(editor, position)
  assert.equal(await page.evaluate(() => window.warmSkillsFallback), false, 'warm skills showed its loading placeholder')
  assert.equal(requests.filter(r => chunk('SkillsPanel')(r.path)).length, 1, 'warm skills triggered another download')

  const settings = page.getByRole('region', {name: '创作区设置'})
  const downloaded = page.waitForResponse(response => chunk('StudioSettingsDialog')(new URL(response.url()).pathname))
  await whilePending(chunk('StudioSettingsDialog'), () => button('Agent 与定时').click(), async () => {
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByRole('status', {name: '正在打开创作区设置'}).waitFor()
    await assertComposer(editor, position)
    await dialog.getByRole('button', {name: /关闭/}).click()
    await dialog.waitFor({state: 'hidden'})
    await assertNoPageFallback()
  })
  await (await downloaded).finished()
  await settled()
  assert.equal(await settings.isVisible(), false, 'late module completion reopened dismissed settings')
  await button('Agent 与定时').click()
  await settings.waitFor()
  await page.keyboard.press('Escape')
  await settings.waitFor({state: 'hidden'})
  assert.equal(requests.filter(r => r.path.endsWith('/studio')).length, initialStudioRequests, 'panels reloaded workspace payload')

  const historyB = '/api/agent/sessions/session-B/history/workspace'
  const isHistoryB = url => new URL(url).pathname === historyB
  let historyBAttempts = 0
  await page.route(isHistoryB, async route => {
    requests.push({path: historyB, document: false})
    historyBAttempts++
    await route.fulfill({status: 503, json: {success: false, error: {code: 'TEMPORARILY_UNAVAILABLE'}}})
  })
  const partialReadFailureB = page.getByRole('status').filter({hasText: '任务资料暂未同步'}).filter({visible:true})
  await whilePending(chunk('AgentMemoryCenter'), () => selectTask(1), async () => {
    await inspector.getByRole('status', {name: '正在打开记忆中心'}).waitFor()
    await partialReadFailureB.waitFor()
    assert.equal(historyBAttempts, 2, 'persistent temporary failures should stop after one automatic retry')
    await assertNoPageFallback()
  })
  const messageReadsB = requests.filter(r => r.path === '/api/agent/sessions/session-B/messages').length
  await page.unroute(isHistoryB)
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === historyB && response.status() === 200),
    button('重试', partialReadFailureB).click(),
  ])
  await partialReadFailureB.waitFor({state:'hidden'})
  assert.equal(requests.filter(r => r.path === '/api/agent/sessions/session-B/messages').length, messageReadsB,
    'task artifact retry reloaded chat messages')
  assert.equal(await composer.innerText(), '', 'task B should keep its own empty composer draft')
  await selectTask(0)
  await contentVisible('试验任务A合成消息47')
  assert.equal(await composer.evaluate((el, original) => el === original, editor), true, 'task switch remounted the composer')
  assert.equal(await composer.innerText(), draft, 'task A draft was lost after returning from task B')

  const shell = await page.locator('[data-app-shell]').elementHandle()
  const work = await workspace.elementHandle()
  await selectTask(1)
  await contentVisible('试验任务B合成消息47')
  assert.equal(await composer.innerText(), '')
  await composer.fill('未发送的虚构草稿 B')
  await selectTask(0)
  await contentVisible('试验任务A合成消息47')
  assert.equal(await composer.innerText(), draft)

  await whilePending(path => path === '/api/novels/novel-1/studio', () => selectTask(2), async () => {
    await page.waitForURL(u => u.pathname === '/studio/novel/novel-1')
    const outgoing = page.locator('[data-work-conversation]:visible')
    await page.waitForFunction(el => el.closest('[inert][aria-busy="true"]') !== null, await outgoing.elementHandle())
    assert.equal(await shell.evaluate(el => el.isConnected && el.checkVisibility()), true, 'shared application shell disappeared')
    assert.equal(await work.evaluate(el => el.isConnected && el.checkVisibility()), true, 'workspace frame disappeared during cross-novel fetch')
    await assertNoPageFallback()
  })
  await page.waitForURL(u => u.pathname === '/studio/novel/novel-1' && !u.searchParams.has('session'))
  await contentVisible('试验任务C合成消息47')
  assert.equal(await composer.innerText(), '')
  assert.equal(await scroll.getByText(/试验任务[AB]合成消息/).count(), 0)
  assert.equal(await composer.evaluate(el => el.closest('[inert]') === null), true, 'new workspace remained locked')
  await selectTask(1)
  await page.waitForURL(u => u.pathname === '/studio/novel/novel-0' && !u.searchParams.has('session'))
  await contentVisible('试验任务B合成消息47')
  assert.equal(await composer.innerText(), '未发送的虚构草稿 B')
  await assertNoPageFallback()
  assert.deepEqual(errors, [])
  const navigationCount = requests.filter(r => r.document).length
  const fallbackFrames = await page.evaluate(() => window.studioFallbackFrames)
  const listUrl = url => url.pathname === '/api/agent/sessions' && url.searchParams.get('novelId') === 'novel-0'
  await page.route(listUrl, route => route.fulfill({status: 503, json: {success: false}}))
  await page.reload()
  await contentVisible('试验任务B合成消息47')
  const listReadFailure = page.getByRole('status').filter({hasText: '任务列表暂未同步'}).filter({visible:true})
  await listReadFailure.waitFor()
  const cachedEditor = await composer.elementHandle()
  await page.unroute(listUrl)
  await button('重试', listReadFailure).click()
  await listReadFailure.waitFor({state:'hidden'})
  await contentVisible('试验任务B合成消息47')
  assert.equal(await composer.evaluate((el, old) => el === old, cachedEditor), true)
  const snapshot = () => page.evaluate(() => {
    const {activeTaskId, tasks} = JSON.parse(localStorage.getItem('studio-agent-workspace:novel-0'))
    return {activeTaskId, taskIds: tasks.map(task => task.id).sort()}
  })
  for (const [action, items] of [['new', sessions.slice(0, 2)], ['away-and-back', []]]) {
    await page.route(listUrl, route => route.fulfill({status: 503, json: {success: false}}))
    await page.goto(origin + '/studio/novel/novel-0?session=session-B')
    await listReadFailure.waitFor()
    const gate = Promise.withResolvers()
    await page.unroute(listUrl)
    await page.route(listUrl, async route => {
      await gate.promise
      await route.fulfill({json: {success: true, data: {items}}})
    })
    try {
      await Promise.all([page.waitForRequest(req => listUrl(new URL(req.url()))), button('重试', listReadFailure).click()])
      if (action === 'new') {
        await button('新对话').click()
        await page.waitForFunction(() => {
          const state = JSON.parse(localStorage.getItem('studio-agent-workspace:novel-0'))
          return state.tasks.some(task => task.id === state.activeTaskId && !task.sessionId)
        })
      } else {
        await selectTask(0)
        await contentVisible('试验任务A合成消息47')
        await selectTask(1)
        await contentVisible('试验任务B合成消息47')
      }
      const pendingDraft = '等待任务列表时的草稿 ' + action
      await composer.fill(pendingDraft)
      const expected = await snapshot()
      assert.ok(expected.taskIds.includes('session-A') && expected.taskIds.includes('session-B'))
      const response = page.waitForResponse(res => listUrl(new URL(res.url())) && res.status() === 200)
      gate.resolve()
      await (await response).finished()
      await settled()
      assert.deepEqual(await snapshot(), expected, 'late task list overwrote a newer window selection: ' + action)
      assert.equal(await composer.innerText(), pendingDraft)
      if (action === 'away-and-back') await contentVisible('试验任务B合成消息47')
    } finally {
      gate.resolve()
      await page.unroute(listUrl)
    }
  }
  // A pending artifact read belongs to its task window, not to the latest selected task.
  // Reset only the fixture snapshot's loaded bit so this exercises a cold history request.
  const historyA = '/api/agent/sessions/session-A/history/workspace'
  const historyReadsBefore = requests.filter(r => r.path === historyA).length
  await page.evaluate(() => {
    const key = 'studio-agent-workspace:novel-0'
    const snapshot = JSON.parse(localStorage.getItem(key))
    snapshot.tasks.find(task => task.sessionId === 'session-A').loaded = false
    localStorage.setItem(key, JSON.stringify(snapshot))
  })
  await page.reload()
  await contentVisible('试验任务B合成消息47')
  const historyStarted = Promise.withResolvers(), historyGate = Promise.withResolvers()
  const isHistoryA = url => new URL(url).pathname === historyA
  await page.route(isHistoryA, async route => {
    requests.push({path: historyA, document: false})
    historyStarted.resolve()
    await historyGate.promise
    await route.fulfill({json: {success: true, data: {items: []}}})
  })
  try {
    await selectTask(0)
    await historyStarted.promise
    await selectTask(1)
    await contentVisible('试验任务B合成消息47')
    historyGate.resolve()
    await page.waitForResponse(response => new URL(response.url()).pathname === historyA && response.status() === 200)
    await selectTask(0)
    await contentVisible('试验任务A合成消息47')
    assert.equal(requests.filter(r => r.path === historyA).length, historyReadsBefore + 1,
      'switching away discarded a successful task history read and caused a duplicate request')
  } finally {
    historyGate.resolve()
    await page.unroute(isHistoryA)
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ coldSurfaces: ['章节查看器', '技能', '创作区设置', '任务 B 记忆中心'], warmSkillsFallback: false,
    tasks: ['甲作品 A', '甲作品 B', '甲作品 A', '乙作品 C', '甲作品 B'], scrollTop: position,
    recoveredReads: ['task artifacts', 'session list'], staleListIgnored: ['new draft', 'away and back'],
    initialHistoryPage: historyPages.find(page => page.session === 'session-A'),
    taskHistoryCachedAfterSwitch: true,
    fullPageFallbacks: fallbackFrames, documentRequests: navigationCount }))
} finally {
  await browser.close()
}
