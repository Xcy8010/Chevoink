import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('生产 nginx 安全响应头', () => {
  const config = readFileSync(resolve(process.cwd(), 'deploy/nginx.chevoink.conf'), 'utf8')

  it('强制执行 CSP，不再停留在无服务端收集端点的 Report-Only 状态', () => {
    expect(config).not.toContain('Content-Security-Policy-Report-Only')
    expect(config.match(/add_header Content-Security-Policy /g)).toHaveLength(4)
  })

  it('仅离线语音 worker 获得 WASM 权限，页面不放宽脚本策略', () => {
    const policies = [...config.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map((match) => match[1])
    expect(policies.filter((policy) => policy.includes("script-src 'self';"))).toHaveLength(2)
    expect(policies.filter((policy) => policy.includes("'wasm-unsafe-eval'"))).toEqual([
      ...Array<string>(2).fill("default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'"),
    ])
    expect(config).toContain('location ~ ^/assets/voice-worker-')
  })

  it('版本化资源只对语音 worker 使用专用策略并保留原 API 鉴权', () => {
    const worker = /location ~ "(\^\/api\/app-releases\/artifacts\/[^"]+)" \{([\s\S]+?)\n {2}\}/.exec(config)
    expect(worker).not.toBeNull()
    const location = new RegExp(worker![1])
    const base = '/api/app-releases/artifacts/test-b0128236-ui-safe-area'
    expect(location.test(base + '/assets/voice-worker-runtime-C4LryM8M.js')).toBe(true)
    expect(location.test(base + '/assets/voice-worker-C4LryM8M.js')).toBe(false)
    expect(location.test(base + '/assets/app.js')).toBe(false)
    expect(location.test(base + '/assets/voice-worker-runtime-C4LryM8M.js.map')).toBe(false)
    expect(location.test(base + '/index.html')).toBe(false)
    expect(worker![2]).toContain('proxy_pass http://127.0.0.1:3001;')
    expect(worker![2]).toContain("'wasm-unsafe-eval'")
  })

  it('脚本与连接仅允许同源，并阻止框架嵌入和 base/form 劫持', () => {
    expect(config).toContain("script-src 'self'")
    expect(config).toContain("connect-src 'self'")
    expect(config).toContain("frame-ancestors 'none'")
    expect(config).toContain("base-uri 'self'")
    expect(config).toContain("form-action 'self'")
  })
})
