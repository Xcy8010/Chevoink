import { Router } from 'express'
import { returnRewardPendingKey, returnRewardTokenFormat } from '../../shared/return-reward.js'

const router = Router()
const base = '/api/credits/return-reward'

router.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  })
  next()
})

router.get('/open', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>领取创作奖励</title><script src="${base}/entry.js" defer></script>
    <p role="status">正在打开领取页面…</p><noscript>请启用 JavaScript 后重新打开邮件链接。</noscript></html>`)
})

router.get('/entry.js', (_req, res) => {
  // Move the fragment into this tab before the immutable app launcher runs.
  // Neither a request URL nor the SPA's artifact-routing query gets the token.
  res.type('js').send(`const token = location.hash.slice(1);
    try {
      if (${returnRewardTokenFormat}.test(token)) sessionStorage.setItem(${JSON.stringify(returnRewardPendingKey)}, token);
      else sessionStorage.removeItem(${JSON.stringify(returnRewardPendingKey)});
      location.replace('/return-reward');
    } catch {
      document.querySelector('p').textContent = '浏览器无法保存领取信息，请在普通浏览窗口重新打开邮件链接。';
    }`)
})

export default router
