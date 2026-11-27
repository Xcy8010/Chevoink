import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const ready = await verifyTestDatabase(isTestDatabaseRequired())
describe.skipIf(!ready)('governance cases on isolated PostgreSQL', () => {
  it('preserves only selected evidence, protects private messages, merges independent reporter receipts and expires evidence', async () => {
    const { prisma } = await import('../../api/lib/prisma.js')
    const { createReport, reviewReport, purgeDueCaseEvidence, casesWithCategory, overdueCases } =
      await import('../../api/lib/governance-cases.js')
    const { supplementCase, updateCaseProgress } = await import('../../api/lib/governance-case-progress.js')
    const [reporter, author, other, admin] = Array.from({ length: 4 }, () => randomUUID())
    const conversation = randomUUID(),
      message = randomUUID(),
      post = randomUUID()
    const requestKeys = Array.from({ length: 12 }, () => randomUUID())
    const novel = randomUUID(),
      chapter = randomUUID(),
      volume = randomUUID(),
      commentIds = Array.from({ length: 3 }, () => randomUUID())
    const submit = (i: number) => ({
      requestKey: requestKeys[i],
      targetKind: 'post' as const,
      targetId: post,
      category: 'other' as const,
      statement: 'synthetic report',
    })
    try {
      await prisma.user.createMany({
        data: [reporter, author, other, admin].map((id) => ({
          id,
          nickname: 'Synthetic',
          passwordHash: 'unset:synthetic',
        })),
      })
      await prisma.post.create({
        data: {
          id: post,
          userId: author,
          content: 'Original public excerpt',
          excerpt: 'Original',
          imageUrls: ['/uploads/posts/synthetic.webp'],
        },
      })
      await prisma.novel.create({
        data: {
          id: novel,
          authorId: author,
          title: 'Synthetic public book',
          slug: novel,
          summary: 'public synopsis',
          status: 'published',
        },
      })
      await prisma.volume.create({
        data: { id: volume, novelId: novel, title: 'Synthetic volume', orderIndex: 1 },
      })
      await prisma.chapter.create({
        data: {
          id: chapter,
          authorId: author,
          novelId: novel,
          volumeId: volume,
          title: 'Chapter',
          content: 'private draft must stay private',
          status: 'published',
          orderIndex: 1,
          orderInVolume: 1,
        },
      })
      for (const [i, targetType] of (['post', 'novel', 'chapter'] as const).entries()) {
        const targetId = [post, novel, chapter][i]
        await prisma.comment.create({
          data: {
            id: commentIds[i],
            userId: author,
            content: 'Synthetic comment',
            targetType,
            targetId,
            ...(targetType === 'post'
              ? { postId: post }
              : targetType === 'novel'
                ? { novelId: novel }
                : { novelId: novel, chapterId: chapter }),
          },
        })
        await expect(
          createReport(reporter, 'synthetic', {
            ...submit(i + 3),
            targetKind: 'comment',
            targetId: commentIds[i],
          }),
        ).resolves.toMatchObject({ status: 'pending' })
      }
      await expect(
        createReport(reporter, 'synthetic', { ...submit(6), targetKind: 'novel', targetId: novel }),
      ).resolves.toMatchObject({ status: 'pending' })
      await expect(
        createReport(reporter, 'synthetic', { ...submit(7), targetKind: 'profile', targetId: author }),
      ).resolves.toMatchObject({ status: 'pending' })
      await expect(
        createReport(null, 'synthetic-public', {
          ...submit(8),
          targetKind: 'platform',
          targetId: 'platform',
        }),
      ).resolves.toMatchObject({ status: 'pending' })
      for (const [kind, targetId] of [
        ['post', post],
        ['novel', novel],
        ['profile', author],
        ...commentIds.map((id) => ['comment', id] as const),
      ] as const) {
        await expect(
          createReport(author, 'synthetic', { ...submit(0), targetKind: kind, targetId }),
        ).rejects.toMatchObject({ code: 'SELF_REPORT' })
      }
      expect(await prisma.governanceCase.count({ where: { reporterId: author } })).toBe(0)
      const multi = await createReport(other, 'synthetic', {
        ...submit(0),
        requestKey: requestKeys[11],
        category: undefined,
        categories: ['privacy', 'harassment', 'privacy'],
      })
      expect((await prisma.governanceCase.findUniqueOrThrow({ where: { id: multi.id } })).category).toBe(
        ',harassment,privacy,',
      )
      await expect(
        createReport(other, 'synthetic', {
          ...submit(0),
          requestKey: randomUUID(),
          category: undefined,
          categories: ['privacy', 'other'],
          statement: ' ',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REASON' })
      await expect(
        createReport(other, 'synthetic', {
          ...submit(0),
          targetKind: 'platform',
          targetId: 'platform',
          category: undefined,
          categories: ['privacy', 'harassment'],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REASON' })
      await prisma.novel.update({ where: { id: novel }, data: { visibility: 'private' } })
      await expect(
        createReport(reporter, 'synthetic', { ...submit(9), targetKind: 'comment', targetId: commentIds[2] }),
      ).rejects.toMatchObject({ status: 404 })
      await prisma.conversation.create({
        data: {
          id: conversation,
          type: 'direct',
          members: { create: [{ userId: author }, { userId: reporter }] },
        },
      })
      await prisma.message.createMany({
        data: [
          {
            id: message,
            conversationId: conversation,
            senderId: author,
            type: 'text',
            content: 'Selected evidence',
          },
          { conversationId: conversation, senderId: author, type: 'text', content: 'Do not collect' },
        ],
      })
      const dm = {
        requestKey: requestKeys[2],
        targetKind: 'message' as const,
        targetId: message,
        category: 'harassment' as const,
        statement: '',
      }
      await expect(createReport(other, 'synthetic', dm)).rejects.toMatchObject({ status: 404 })
      await expect(createReport(author, 'synthetic', dm)).rejects.toMatchObject({ code: 'SELF_REPORT' })
      const selected = await createReport(reporter, 'synthetic', dm)
      const stored = await prisma.governanceCase.findUniqueOrThrow({ where: { id: selected.id } })
      expect(stored.snapshot).toBe('Selected evidence')
      await prisma.message.delete({ where: { id: message } })
      expect((await prisma.governanceCase.findUniqueOrThrow({ where: { id: selected.id } })).snapshot).toBe(
        stored.snapshot,
      )
      const [a, retry] = await Promise.all([
        createReport(reporter, 'synthetic', submit(0)),
        createReport(reporter, 'synthetic', submit(0)),
      ])
      expect(a).toEqual(retry)
      const b = await createReport(other, 'synthetic', submit(1))
      expect(b.receipt).not.toBe(a.receipt)
      const clock = new Date()
      await prisma.governanceCase.update({
        where: { id: multi.id },
        data: { acknowledgeBy: new Date(+clock - 1000) },
      })
      for (const reason of ['privacy', 'harassment']) {
        expect(
          await prisma.governanceCase.findMany({
            where: { reporterId: other, AND: [casesWithCategory(reason), overdueCases(clock)] },
            select: { id: true },
          }),
        ).toEqual([{ id: multi.id }])
      }
      expect(await prisma.governanceCase.count({ where: { id: b.id, ...casesWithCategory('other') } })).toBe(
        1,
      )
      expect(
        await prisma.governanceCase.count({
          where: { reporterId: other, AND: [casesWithCategory('other'), overdueCases(clock)] },
        }),
      ).toBe(0)
      await updateCaseProgress(a.id, admin, 'request_materials', 'Please clarify the selected passage')
      await expect(
        supplementCase(a.id, { kind: 'report', receipt: b.receipt }, 'another case'),
      ).rejects.toMatchObject({ status: 404 })
      expect((await prisma.governanceCase.findUniqueOrThrow({ where: { id: a.id } })).feedbackBy).toBeNull()
      await supplementCase(a.id, { kind: 'report', receipt: a.receipt }, 'Synthetic clarification')
      const supplied = await prisma.governanceCase.findUniqueOrThrow({ where: { id: a.id } })
      expect(supplied.materialsAt).not.toBeNull()
      expect(supplied.feedbackBy!.getTime()).toBeGreaterThan(supplied.materialsAt!.getTime())
      await reviewReport(b.id, admin, { status: 'linked', relatedId: a.id, reason: 'Same post' })
      await prisma.post.update({ where: { id: post }, data: { content: 'Edited' } })
      expect((await prisma.governanceCase.findUniqueOrThrow({ where: { id: a.id } })).snapshot).toBe(
        'Original public excerpt\n/uploads/posts/synthetic.webp',
      )
      await reviewReport(a.id, admin, { status: 'dismissed', reason: 'Insufficient evidence' })
      expect((await prisma.governanceCase.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
        'dismissed',
      )
      expect(
        await prisma.userNotification.count({
          where: { userId: { in: [reporter, other] }, body: { contains: '尚未发现足以认定违规' } },
        }),
      ).toBe(2)
      expect(await prisma.accountRestriction.count({ where: { userId: author } })).toBe(0)
      await purgeDueCaseEvidence()
      const closed = await prisma.governanceCase.findUniqueOrThrow({ where: { id: a.id } })
      expect(closed.statement).toBeNull()
      expect(closed.snapshot).toBeNull()
    } finally {
      const where = { requestKey: { in: requestKeys } }
      const cases = await prisma.governanceCase.findMany({ where, select: { id: true } })
      await prisma.governanceCaseEvent.deleteMany({ where: { caseId: { in: cases.map((c) => c.id) } } })
      await prisma.governanceCase.deleteMany({ where })
      await prisma.adminAuditLog.deleteMany({ where: { adminId: admin } })
      await prisma.message.deleteMany({ where: { conversationId: conversation } })
      await prisma.conversationMember.deleteMany({ where: { conversationId: conversation } })
      await prisma.conversation.deleteMany({ where: { id: conversation } })
      await prisma.comment.deleteMany({ where: { id: { in: commentIds } } })
      await prisma.chapter.deleteMany({ where: { id: chapter } })
      await prisma.volume.deleteMany({ where: { id: volume } })
      await prisma.novel.deleteMany({ where: { id: novel } })
      await prisma.post.deleteMany({ where: { id: post } })
      await prisma.user.deleteMany({ where: { id: { in: [reporter, author, other, admin] } } })
    }
  })
})
