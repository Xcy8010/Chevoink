import { expect, it } from 'vitest'
import type { ChatMessage } from '../../api/lib/ai-service.js'
import { estimateChatMessagesTokens } from '../../api/lib/agent/context-budget.js'
import { planSemanticCompaction, restoreSemanticHistory } from '../../api/lib/agent/semantic-compaction.js'

const author: ChatMessage = { role: 'user', content: '六处都改，第六处只能改日期。' }
const quote = '只改日期，动机保持原样。'
const archived: ChatMessage = { role: 'assistant', historySourceId: 'old:text', content: '以前的笔记。'.repeat(2200) + quote }
const latest: ChatMessage = { role: 'assistant', content: '最新的细纲必须逐项核对。' }
const messages = [author, archived, latest]
const estimate = (items: ChatMessage[]) => estimateChatMessagesTokens(items) + 60_000

it('restores the vetted summary of immutable history and keeps author and latest data verbatim', () => {
  const plan = planSemanticCompaction(messages, 57_000, estimate)!
  expect(plan.content).not.toContain(author.content)
  const result = plan.apply(JSON.stringify({ notes: [{ source: 1, quote }] }))!
  expect(result[0]).toBe(author)
  expect(result.at(-1)).toBe(latest)
  expect(result[1].content).toContain('[old] ' + quote)
  const receipt = plan.receipt(result)
  expect(restoreSemanticHistory(messages, receipt)).toEqual(result)
  expect(restoreSemanticHistory([author, { ...archived, content: '新版' }, latest], receipt)).toBeNull()
  expect(restoreSemanticHistory([author, latest], receipt)).toBeNull()
})

it('rejects invented quotes, malformed or oversized output, and spends nothing below the soft ceiling', () => {
  const plan = planSemanticCompaction(messages, 57_000, estimate)!
  for (const output of ['{}', '截断', JSON.stringify({ notes: [{ source: 2, quote }] }),
    JSON.stringify({ notes: [{ source: 1, quote: '动机可以改' }] }),
    JSON.stringify({ notes: [{ source: 1, quote: '以前的笔记。'.repeat(1001) }] })]) expect(plan.apply(output)).toBeNull()
  expect(planSemanticCompaction(messages, 57_000, estimateChatMessagesTokens)).toBeNull()
  expect(planSemanticCompaction([author, latest], 1000, estimate)).toBeNull()
  expect(plan.apply(JSON.stringify({ notes: [{ source: 1, quote: '动机保持原样。' }] }))).toBeNull()
  const negated = planSemanticCompaction([author, { ...archived, content: '先确认。'.repeat(3000) + '禁止删除第六场。' }], 1000, estimate)!
  expect(negated.apply(JSON.stringify({ notes: [{ source: 1, quote: '删除第六场。' }] }))).toBeNull()
})
