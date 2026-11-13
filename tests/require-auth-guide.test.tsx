// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RequireAuthRoute from '../src/app/routes/RequireAuthRoute'

const auth = vi.hoisted(() => ({ authStatus: 'guest', sessionUser: null as null | { id: string } }))
vi.mock('@/store/useShellStore', () => ({ useShellStore: (selector: (state: typeof auth) => unknown) => selector(auth) }))
afterEach(() => { cleanup(); auth.authStatus = 'guest'; auth.sessionUser = null })

describe('centered unauthenticated guidance', () => {
  it('shows branding and login links with the full return destination', () => {
    render(<MemoryRouter initialEntries={['/messages?conversationId=example#latest']}><RequireAuthRoute centered><div>private messages</div></RequireAuthRoute></MemoryRouter>)
    const state = screen.getByRole('heading', { name: '登录后继续' }).closest('section')!
    const mascot = state.querySelector('img')!
    expect(mascot.getAttribute('src')).toBe('/chevoink-agent-welcome.webp')
    expect(mascot.getAttribute('alt')).toBe('')
    expect(mascot.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('link', { name: '去登录' }).getAttribute('href')).toBe('/login?redirect=%2Fmessages%3FconversationId%3Dexample%23latest')
    expect(screen.getByRole('link', { name: '创建账户' }).getAttribute('href')).toBe('/register?redirect=%2Fmessages%3FconversationId%3Dexample%23latest')
    expect(screen.queryByText('private messages')).toBeNull()
    expect(state.classList.contains('flex-1')).toBe(true)
    expect(state.parentElement?.classList.contains('overflow-y-auto')).toBe(true)
  })

  it.each(['guest', 'checking', 'unavailable'])('does not mount private queries when %s', (status) => {
    auth.authStatus = status
    const Child = vi.fn(() => <div>private messages</div>)
    render(<MemoryRouter><RequireAuthRoute centered><Child /></RequireAuthRoute></MemoryRouter>)
    expect(Child).not.toHaveBeenCalled()
    if (status !== 'guest') expect(screen.queryByRole('link', { name: '去登录' })).toBeNull()
  })

  it('renders authenticated content without the guest wrapper', () => {
    auth.authStatus = 'authenticated'; auth.sessionUser = { id: 'test' }
    render(<MemoryRouter><RequireAuthRoute centered><div>private messages</div></RequireAuthRoute></MemoryRouter>)
    expect(screen.getByText('private messages')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '登录后继续' })).toBeNull()
  })
})
