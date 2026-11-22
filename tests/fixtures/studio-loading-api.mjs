const date = '2025-07-01T12:00:00Z'
const user = {
  id: 'fixture-author', nickname: '测试作者', status: 'active', emailVerified: true,
  phoneVerified: true, studioPhoneVerificationRequired: false, isAdmin: false,
}
const novels = ['甲', '乙'].map((label, index) => ({
  id: 'novel-' + index, title: label + '作品', authorId: user.id, author: user, status: 'draft', visibility: 'private',
  tags: [], createdAt: date, updatedAt: date, summary: '', chapterCount: 1, wordCount: 8,
}))
export const sessions = ['A', 'B', 'C', 'D'].map((letter, index) => {
  const owner = novels[index < 2 ? 0 : 1]
  return { id: 'session-' + letter, novelId: owner.id, userId: user.id, title: '试验任务' + letter, novelTitle: owner.title,
    status: 'active', pinnedAt: null, lastRunAt: date, createdAt: date, updatedAt: date }
})
function chapter(novel) {
  return { id: 'chapter-' + novel.id, novelId: novel.id, authorId: user.id, title: novel.title + '测试章节', content: novel.title + '测试正文',
    orderIndex: 1, orderInVolume: 1, volumeId: 'vol-' + novel.id, wordCount: 8, revision: 1,
    status: 'draft', visibility: 'private', commentCount: 0, createdAt: date, updatedAt: date }
}
function messageHistory(session) {
  return Array.from({length: 48}, (_, index) => ({
    id: session.id + '-message-' + index, runId: session.id + '-run-' + Math.floor(index / 2),
    role: index % 2 === 0 ? 'user' : 'assistant', createdAt: new Date(Date.parse(date) + index * 1000).toISOString(),
    parts: [{type: 'text', text: session.title + '合成消息' + index}],
  }))
}
export function studioApi(url) {
  const path = url.pathname
  if (path === '/api/app-releases/bootstrap') return { mode: 'legacy', release: null }
  if (path === '/api/users/me') return { user, authoredNovels: novels, activities: [], drafts: [], shelf: [], notifications: [], stats: [], statCards: [], recentConversations: [] }
  if (path === '/api/agent/sessions') return { items: sessions.filter(s => !url.searchParams.has('novelId') || s.novelId === url.searchParams.get('novelId')) }
  for (const novel of novels) {
    const first = chapter(novel)
    if (path === '/api/agent/novels/' + novel.id + '/skills') return {items: [], totalCount: 0, enabledCount: 0, recentRuns: []}
    if (path === '/api/novels/' + novel.id + '/studio') return { novel, draftChapter: first, chapters: [first],
      volumes: [{id: first.volumeId, novelId: novel.id, title: novel.title + '第一卷', orderIndex: 1}], coverAssets: [], featureFlags: {dualWorkspace: true} }
    if (path.endsWith('/chapters/' + first.id)) return {chapter: first}
  }
  for (const session of sessions) {
    const root = '/api/agent/sessions/' + session.id
    if (path === root + '/messages') return { messages: messageHistory(session), activeRunId: null, runGoalId: null, pagination: {hasMore: false, earliestRunStartedAt: null} }
    if (path === root + '/history' || path === root + '/queue') return {items: []}
    if (path === root + '/questions/pending') return {question: null}
  }
  return undefined
}
