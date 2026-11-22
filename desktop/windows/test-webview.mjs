// Real installed WebView2 on the isolated CI runner. Never attach to a user's browser.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable CI runner only')
const endpoints = await fetch('http://127.0.0.1:19222/json/list', { signal: AbortSignal.timeout(10000) }).then(r => r.json())
const target = endpoints.find(p => p.type === 'page' && /^(https:\/\/chevoink\.chevolink\.com(?:\/|$)|http:\/\/tauri\.localhost\/)/.test(p.url))
assert.ok(target, 'Packaged WebView2 page must exist')
const endpoint = new URL(target.webSocketDebuggerUrl)
assert.ok(['localhost', '127.0.0.1'].includes(endpoint.hostname) && endpoint.port === '19222')
const socket = new WebSocket(endpoint)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP open timeout')), 10000)
  socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP open failed')) }, { once: true })
})
let id = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data)
  if (value.method === 'Fetch.requestPaused') {
    // This exact synthetic page exercises the real packaged IPC origin without
    // authenticating, requesting account data or depending on a deployed candidate.
    void call('Fetch.fulfillRequest', {
      requestId: value.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from('<!doctype html><title>Desktop caption CI</title>').toString('base64'),
    }).catch(error => { throw error })
    return
  }
  const request = pending.get(value.id)
  if (!request) return
  pending.delete(value.id)
  clearTimeout(request.timer)
  if (value.error) request.reject(new Error(JSON.stringify(value.error)))
  else request.resolve(value.result)
})
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)) }, 10000)
    pending.set(requestId, { resolve, reject, timer })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert.ok(!result.exceptionDetails, 'Unexpected page exception')
  return result.result.value
}
async function ready(hash) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate(`location.origin === 'http://tauri.localhost' && location.hash === ${JSON.stringify(hash)} && document.readyState === 'complete'`)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Fallback navigation did not complete')
}
try {
  await call('Page.enable')
  await call('Page.navigate', { url: 'http://tauri.localhost/#tls' })
  await ready('#tls')
  assert.match(await evaluate('document.body.innerText'), /安全证书/)
  const { version } = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert.ok((await evaluate('navigator.userAgent')).includes('ChevoinkDesktop/' + version))
  for (const [reason, text] of [['dns', 'DNS'], ['timeout', '超时'], ['engine', 'WebView2']]) {
    await call('Page.navigate', { url: `http://tauri.localhost/#${reason}` })
    await ready(`#${reason}`)
    assert.ok((await evaluate('document.body.innerText')).includes(text))
  }
  // Reload persistence is tested only on the packaged origin, not a real account.
  await evaluate("localStorage.setItem('ci-webview-probe', 'persisted')")
  await call('Page.navigate', { url: 'http://tauri.localhost/#tls' })
  await ready('#tls')
  await call('Page.reload')
  await new Promise(resolve => setTimeout(resolve, 500))
  await ready('#tls')
  assert.equal(await evaluate("localStorage.getItem('ci-webview-probe')"), 'persisted')
  await evaluate("localStorage.removeItem('ci-webview-probe')")
  // Tauri's real navigation boundary, not a mocked URL predicate.
  await call('Page.navigate', { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(await evaluate('location.origin'), 'http://tauri.localhost')
  const denied = await evaluate(`(async () => {
    if (!window.__TAURI_INTERNALS__?.invoke) return 'unavailable';
    try { await window.__TAURI_INTERNALS__.invoke('desktop_get_info'); return 'allowed' }
    catch { return 'denied' }
  })()`)
  assert.ok(['denied', 'unavailable'].includes(denied), 'Packaged fallback cannot call remote-only IPC')
  const fixture = 'https://chevoink.chevolink.com/__desktop_ci_caption'
  await call('Fetch.enable', { patterns: [{ urlPattern: fixture, resourceType: 'Document' }] })
  await call('Page.navigate', { url: fixture })
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.title === 'Desktop caption CI' && !!window.__TAURI_INTERNALS__?.invoke")) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const caption = action => evaluate("window.__TAURI_INTERNALS__.invoke('desktop_caption', {action:" + JSON.stringify(action) + "})")
  assert.equal((await caption('state')).decorated, true, 'Old web page keeps system controls')
  const attached = await caption('attach')
  assert.equal(attached.decorated, false)
  await caption('toggleMaximize')
  for (let attempt = 0; attempt < 30 && (await caption('state')).maximized === attached.maximized; attempt++)
    await new Promise(resolve => setTimeout(resolve, 100))
  assert.notEqual((await caption('state')).maximized, attached.maximized, 'Native maximize/restore changed the real window')
  assert.equal((await caption('system')).decorated, true)
  await caption('attach')
  await call('Page.navigate', { url: 'http://tauri.localhost/#dns' })
  await ready('#dns')
  await call('Page.navigate', { url: fixture })
  for (let attempt = 0; attempt < 50 && !await evaluate("document.title === 'Desktop caption CI'"); attempt++)
    await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await caption('state')).decorated, true, 'Fresh page gets working system controls again')
  await call('Fetch.disable')
  await call('Page.navigate', { url: 'http://tauri.localhost/#tls' })
  await ready('#tls')
  console.log('PASS: real WebView2 fallback, UA, persistence, external navigation, IPC, native caption and maximize/restore')
} finally {
  socket.close()
  for (const request of pending.values()) clearTimeout(request.timer)
}
