import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'

import type {
  CreateChapterRequest,
  CreateCommentRequest,
  CreateNovelRequest,
  CreatePostRequest,
  PublishNovelRequest,
  ResolveAgentApprovalRequest,
  ResolveAgentQuestionRequest,
  StartAgentLoopRunRequest,
  UpdateChapterRequest,
  UpdateNovelRequest,
  UploadAgentAttachmentRequest,
  UploadNovelCoverRequest,
} from '../../shared/contracts/index.js'
import {
  createChapterSchema,
  createCommentSchema,
  createNovelSchema,
  createPostSchema,
  publishNovelSchema,
  resolveAgentApprovalSchema,
  resolveAgentQuestionSchema,
  agentQuestionPromptsSchema,
  startAgentLoopRunSchema,
  updateChapterSchema,
  updateNovelSchema,
  uploadAgentAttachmentSchema,
  uploadNovelCoverSchema,
} from '../../shared/contracts/schemas.js'

/**
 * 阶段 L1：zod schema 的 z.output 必须与 contracts 手写请求类型全等，
 * 锁死两处枚举/可空性不漂移；另有少量行为对照快测（语义对齐原路由断言）。
 */

describe('P0 schema 类型全等（z.output vs contracts）', () => {
  it('novels 六端点', () => {
    expectTypeOf(z.output<typeof createNovelSchema>).toEqualTypeOf<CreateNovelRequest>()
    expectTypeOf(z.output<typeof updateNovelSchema>).toEqualTypeOf<UpdateNovelRequest>()
    expectTypeOf(z.output<typeof uploadNovelCoverSchema>).toEqualTypeOf<UploadNovelCoverRequest>()
    expectTypeOf(z.output<typeof publishNovelSchema>).toEqualTypeOf<PublishNovelRequest>()
    expectTypeOf(z.output<typeof createChapterSchema>).toEqualTypeOf<CreateChapterRequest>()
    expectTypeOf(z.output<typeof updateChapterSchema>).toEqualTypeOf<UpdateChapterRequest>()
  })

  it('posts / comments', () => {
    expectTypeOf(z.output<typeof createPostSchema>).toEqualTypeOf<CreatePostRequest>()
    expectTypeOf(z.output<typeof createCommentSchema>).toEqualTypeOf<CreateCommentRequest>()
  })

  it('agent 四端点', () => {
    expectTypeOf(z.output<typeof startAgentLoopRunSchema>).toEqualTypeOf<StartAgentLoopRunRequest>()
    expectTypeOf(z.output<typeof resolveAgentApprovalSchema>).toEqualTypeOf<ResolveAgentApprovalRequest>()
    expectTypeOf(z.output<typeof resolveAgentQuestionSchema>).toEqualTypeOf<ResolveAgentQuestionRequest>()
    expectTypeOf(z.output<typeof uploadAgentAttachmentSchema>).toEqualTypeOf<UploadAgentAttachmentRequest>()
  })
})

describe('P0 schema 行为对齐原路由断言', () => {
  it('createNovel：纯空白标题/简介拒绝（原 !x?.trim() 判定），tags 缺省补 []', () => {
    expect(createNovelSchema.safeParse({ title: '   ', summary: 'x' }).success).toBe(false)
    expect(createNovelSchema.safeParse({ title: 'x', summary: ' ' }).success).toBe(false)
    const parsed = createNovelSchema.parse({ title: ' 测试 ', summary: '简介' })
    expect(parsed.tags).toEqual([])
    // 原样透传不做 trim 变换（trim 由路由手动执行，保持行为一致）
    expect(parsed.title).toBe(' 测试 ')
  })

  it('updateNovel：空对象通过（原零校验透传），未知字段被剔除，coverAssetId 允许 null', () => {
    const parsed = updateNovelSchema.parse({ hacked: 1, coverAssetId: null })
    expect(parsed).toEqual({ coverAssetId: null })
    expect(updateNovelSchema.safeParse({ status: 'bogus' }).success).toBe(false)
  })

  it('publishNovel：chapterIds 缺省补 []，空串 id 拒绝（原 filter 剔除，此处收紧为 400）', () => {
    expect(publishNovelSchema.parse({}).chapterIds).toEqual([])
    expect(publishNovelSchema.safeParse({ chapterIds: [''] }).success).toBe(false)
  })

  it('createChapter：content 空串通过（原仅拒缺省）、status 非法枚举拒绝', () => {
    expect(createChapterSchema.safeParse({ title: 't', content: '', status: 'draft' }).success).toBe(true)
    expect(createChapterSchema.safeParse({ title: 't', content: 'c', status: 'bogus' }).success).toBe(false)
    expect(updateChapterSchema.safeParse({ content: '新版', expectedRevision: 3 }).success).toBe(true)
    expect(updateChapterSchema.safeParse({ expectedRevision: 0 }).success).toBe(false)
  })

  it('createPost / createComment：核心字段空白拒绝，paragraphIndex 允许 null', () => {
    expect(createPostSchema.safeParse({ content: '  ' }).success).toBe(false)
    expect(createCommentSchema.safeParse({ targetType: 'novel', targetId: 'x', content: ' ' }).success).toBe(false)
    expect(
      createCommentSchema.safeParse({ targetType: 'novel', targetId: 'x', content: 'c', paragraphIndex: null })
        .success,
    ).toBe(true)
    expect(createCommentSchema.safeParse({ targetType: 'video', targetId: 'x', content: 'c' }).success).toBe(false)
  })

  it('agent：prompt 纯空白拒绝、mode/approved 错型拒绝、attachments 形状校验', () => {
    expect(
      startAgentLoopRunSchema.safeParse({ sessionId: 's', novelId: 'n', mode: 'build', prompt: '  ' }).success,
    ).toBe(false)
    expect(
      startAgentLoopRunSchema.safeParse({ sessionId: 's', novelId: 'n', mode: 'bogus', prompt: 'p' }).success,
    ).toBe(false)
    expect(resolveAgentApprovalSchema.safeParse({ callId: 'c', approved: 'yes' }).success).toBe(false)
    expect(resolveAgentQuestionSchema.safeParse({ callId: 'c', answer: ' ' }).success).toBe(false)
    expect(resolveAgentQuestionSchema.parse({ callId: 'c', answer: '旧案' })).toEqual({ callId: 'c', answer: '旧案' })
    expect(resolveAgentQuestionSchema.parse({ callId: 'c', answers: ['旧案', '第一人称'] }))
      .toEqual({ callId: 'c', answers: ['旧案', '第一人称'] })
    expect(resolveAgentQuestionSchema.parse({ callId: 'c', cancelled: true })).toEqual({ callId: 'c', cancelled: true })
    expect(resolveAgentQuestionSchema.safeParse({ callId: 'c', cancelled: true, answers: ['尚未提交'] }).success).toBe(false)
    expect(resolveAgentQuestionSchema.safeParse({ callId: 'c', answers: ['旧案', ' '] }).success).toBe(false)
    const prompt = { question: '故事主线？', options: [{ label: '旧案' }, { label: '失踪' }] }
    expect(agentQuestionPromptsSchema.safeParse([prompt, prompt, prompt]).success).toBe(true)
    expect(agentQuestionPromptsSchema.safeParse([{ ...prompt, question: ' ' }]).success).toBe(false)
    expect(agentQuestionPromptsSchema.safeParse([prompt, prompt, prompt, prompt]).success).toBe(false)
    expect(uploadAgentAttachmentSchema.safeParse({ kind: 'image', name: 'n', dataUrl: 'd' }).success).toBe(true)
    expect(uploadAgentAttachmentSchema.safeParse({ kind: 'video', name: 'n', dataUrl: 'd' }).success).toBe(false)
    const run = startAgentLoopRunSchema.parse({
      sessionId: 's',
      novelId: 'n',
      mode: 'build',
      prompt: 'p',
      attachments: [{ id: 'a', kind: 'file', name: 'f', url: '/api/uploads/agent-attachments/u/a.txt' }],
    })
    expect(run.attachments?.[0].size).toBeUndefined()
    expect(startAgentLoopRunSchema.safeParse({
      sessionId: 's',
      novelId: 'n',
      mode: 'build',
      prompt: 'p',
      attachments: Array.from({ length: 7 }, (_, index) => ({
        id: `i${index}`,
        kind: 'image',
        name: `i${index}.png`,
        url: `/api/uploads/agent-attachments/u/i${index}.png`,
      })),
    }).success).toBe(false)
    expect(startAgentLoopRunSchema.safeParse({
      sessionId: 's',
      novelId: 'n',
      mode: 'build',
      prompt: 'x'.repeat(20_001),
    }).success).toBe(false)
  })
})
