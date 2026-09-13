import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('checked-in import reverse-proxy contract (not nginx runtime validation)', () => {
  const config = readFileSync(new URL('../../deploy/nginx.chevoink.conf', import.meta.url), 'utf8')
  it('streams only exact source endpoints with the server-side 50 MiB cap', () => {
    const location = config.match(/location ~\* \^\/api\/novels\/\[\^\/\]\+\/imports\/\[a-f0-9-\]\+\/source\$ \{([\s\S]*?)\n {2}\}/)?.[1]
    expect(location).toBeDefined()
    expect(location).toContain('client_max_body_size 50m;')
    expect(location).toContain('proxy_request_buffering off;')
    expect(location).toContain('proxy_buffering off;')
    expect(location).toContain('proxy_pass http://127.0.0.1:3001;')
    expect(location).not.toMatch(/\balias\b|\broot\b/)
  })
  it('does not globally increase JSON limits or weaken authenticated attachments', () => {
    expect(config.match(/location \/api\/ \{([\s\S]*?)\n {2}\}/)?.[1]).toContain('client_max_body_size 40m;')
    expect(config).toContain('location ^~ /api/uploads/agent-attachments/')
  })
})
