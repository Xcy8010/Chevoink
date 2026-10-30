// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentMarkdownText } from '../../src/features/studio/agent/components/AgentMarkdownText'

afterEach(() => { cleanup(); vi.useRealTimers() })
// These assertions cover rendering/security, not Vite's cold dependency transform
// speed. Await the real lazy dependencies before the default 1s DOM deadline.
beforeAll(async () => {
  await Promise.all([import('react-markdown'), import('remark-gfm'), import('../../shared/agent-output.js')])
}, 30_000)

describe('J4 assistant Markdown', () => {
  it('removes hidden tool-status line boxes and empty paragraphs without flattening prose or code', async () => {
    const view = render(<AgentMarkdownText text={'核对前章。\n[调用工具 novel_get_context：读取上下文]\n[调用工具 chapter_read：读取正文]\n[调用工具 memory_search：检索]\n\n[调用工具 other：准备]\n\n第一行\n第二行\n\n```text\n[调用工具 example：保留代码]\n```'} />)
    await waitFor(() => expect(view.container.querySelector('code')).toBeTruthy())
    expect([...view.container.querySelectorAll('p')].map(p => p.textContent)).toEqual(['核对前章。', '第一行\n第二行'])
    expect(view.container.querySelector('code')?.textContent).toContain('[调用工具 example：保留代码]')
  })
  it('renders existing prose, lists and a keyboard-scrollable GFM table without changing the input', async () => {
    const text = '# 分析\n\n**结论**\n\n- 原因一\n- 原因二\n\n| 章节 | 证据 |\n| --- | --- |\n| 第一章 | 水渠 |'
    const view = render(<AgentMarkdownText text={text} />)
    expect(await screen.findByRole('table')).toBeTruthy()
    expect(screen.getByRole('region', { name: '分析表格，可横向滚动' }).tabIndex).toBe(0)
    expect(view.container.querySelector('strong')?.textContent).toBe('结论')
    expect(view.container.querySelectorAll('li')).toHaveLength(2)
    expect(text).toContain('**结论**')
  })
  it('blocks executable links, raw HTML and automatic remote-image loading', async () => {
    const view = render(<AgentMarkdownText text={'[安全](https://example.com/source?id=19)\n\n[危险](javascript:alert%281%29)\n\n![追踪](https://example.com/track.png)\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>'} />)
    const link = await screen.findByRole('link', { name: '安全' })
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('href')).toBe('https://example.com/source?id=19')
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull()
    expect(view.container.querySelector('img,script,iframe')).toBeNull()
    expect(view.container.textContent).toContain('图片：追踪，未自动加载')
  })
  it('preserves protocol-looking code examples while removing actual protocol blocks', async () => {
    const code = '<invoke name="example">{"tasks":[]}</invoke>'
    const view = render(<AgentMarkdownText text={`说明\n\n\`\`\`json\n${code}\n\`\`\`\n\n<invoke name="hidden">private trace</invoke>`} />)
    await waitFor(() => expect(view.container.querySelector('code')?.textContent).toContain(code))
    expect(view.container.textContent).not.toContain('private trace')
  })
  it('reparses late reference definitions and keeps an existing table mounted across chunks', async () => {
    const table = '| 章节 | 结论 |\n| --- | --- |\n| 一 | 合作 |'
    const view = render(<AgentMarkdownText text={`${table}\n\n[依据][source]`} />)
    const original = await screen.findByRole('table')
    view.rerender(<AgentMarkdownText text={`${table}\n| 二 | 冲突 |\n\n[依据][source]\n\n[source]: https://example.com/book`} />)
    expect(await screen.findByRole('link', { name: '依据' })).toBeTruthy()
    expect(screen.getByRole('table')).toBe(original)
  })
  it('coalesces active text, flushes immediately on completion and never leaks a task switch', async () => {
    const view = render(<AgentMarkdownText text="**开始**" identity="a" streaming />)
    await waitFor(() => expect(view.container.querySelector('strong')).toBeTruthy())
    vi.useFakeTimers()
    view.rerender(<AgentMarkdownText text="**开始**推进" identity="a" streaming />)
    view.rerender(<AgentMarkdownText text="**开始**推进任务" identity="a" streaming />)
    expect(view.container.textContent).toBe('开始')
    await act(async () => { await vi.advanceTimersByTimeAsync(160) })
    expect(view.container.textContent).toBe('开始推进任务')
    view.rerender(<AgentMarkdownText text="**已经完成**" identity="a" />)
    expect(view.container.textContent).toBe('已经完成')
    view.rerender(<AgentMarkdownText text="新任务" identity="b" streaming />)
    expect(view.container.textContent).toBe('新任务')
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    expect(view.container.textContent).toBe('新任务')
  })
})
