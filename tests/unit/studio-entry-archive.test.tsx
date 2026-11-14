// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import StudioPage from '../../src/pages/StudioPage'

const { getMe, createNovelWorkspace } = vi.hoisted(() => ({ getMe: vi.fn(), createNovelWorkspace: vi.fn() }))
vi.mock('@/features/community/api', () => ({ getMe }))
vi.mock('@/features/studio/api', () => ({ createNovelWorkspace }))
vi.mock('@/features/studio/StudioWorkspace', () => ({
  default: function WorkspaceRoute() { return <p>{useParams().novelId}</p> },
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.resetAllMocks()
})

it('resumes an active work when the last work and most recent draft are archived', async () => {
  localStorage.setItem('studio-last-novel-id', 'archived-work')
  getMe.mockResolvedValue({
    user: { id: 'synthetic-owner' },
    authoredNovels: [
      { id: 'archived-work', status: 'archived', updatedAt: '2026-11-13' },
      { id: 'other-work', status: 'draft', updatedAt: '2026-11-12' },
      { id: 'unfinished-work', status: 'draft', updatedAt: '2026-11-11' },
    ],
    drafts: [{ novelId: 'archived-work' }, { novelId: 'unfinished-work' }],
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/studio']}>
    <Routes>
      <Route path="/studio" element={<StudioPage />} />
      <Route path="/studio/novel/:novelId" element={<StudioPage />} />
    </Routes>
  </MemoryRouter></QueryClientProvider>)
  expect(await screen.findByText('unfinished-work')).toBeTruthy()
  expect(createNovelWorkspace).not.toHaveBeenCalled()
})
