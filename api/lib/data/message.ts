import { assertGovernanceAllowed } from '../governance-access.js'
/**
 * 私信会话域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import type { Conversation, Message, SendMessageRequest } from '../../../shared/contracts/index.js'
import { storeMessageImageDataUrl } from '../message-image-storage.js'
import { DataAccessError, prisma } from '../prisma.js'
import { attachDirectFollowRelations, attachMessageCards, buildPagination, conversationInclude, ensureConversationMember, ensureNonEmptyText, ensureUserExists, toConversation, toMessage } from './internal.js'



/** 创建或复用与目标用户的双人直聊会话；目标用户不存在时返回 null */
export async function createDirectConversationData(
  viewerUserId: string,
  targetUserId: string,
): Promise<Conversation | null> {
  await ensureUserExists(viewerUserId)

  if (viewerUserId === targetUserId) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '不能给自己发私信。')
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } })
  if (!target) {
    return null
  }

  // 已存在的双人直聊直接复用，避免重复建会话
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'direct',
      AND: [
        { members: { some: { userId: viewerUserId } } },
        { members: { some: { userId: targetUserId } } },
      ],
    },
    include: conversationInclude,
  })

  if (existing) {
    const [enriched] = await attachDirectFollowRelations([toConversation(existing, viewerUserId)], viewerUserId)
    return enriched
  }

  const created = await prisma.conversation.create({
    data: {
      type: 'direct',
      members: {
        create: [{ userId: viewerUserId }, { userId: targetUserId }],
      },
    },
    include: conversationInclude,
  })

  const [enriched] = await attachDirectFollowRelations([toConversation(created, viewerUserId)], viewerUserId)
  return enriched
}



export async function listConversationsData(userId: string, page: number, pageSize: number) {
  await ensureUserExists(userId)

  const [items, total] = await prisma.$transaction([
    prisma.conversation.findMany({
      where: {
        members: {
          some: {
            userId,
          },
        },
      },
      include: conversationInclude,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.conversation.count({
      where: {
        members: {
          some: {
            userId,
          },
        },
      },
    }),
  ])

  // 按成员 lastReadAt 计算真实未读数（他人发送且晚于上次已读）
  const unreadCounts = await Promise.all(
    items.map((item) => {
      const member = item.members.find((entry) => entry.userId === userId)
      return prisma.message.count({
        where: {
          conversationId: item.id,
          senderId: { not: userId },
          createdAt: { gt: member?.lastReadAt ?? new Date(0) },
        },
      })
    }),
  )

  return {
    items: await attachDirectFollowRelations(
      items.map((item, index) => ({ ...toConversation(item, userId), unreadCount: unreadCounts[index] })),
      userId,
    ),
    pagination: buildPagination(page, pageSize, total),
  }
}



export async function markConversationReadData(
  userId: string,
  conversationId: string,
): Promise<{ conversationId: string; lastReadAt: string }> {
  await ensureConversationMember(userId, conversationId)

  const now = new Date()
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data: { lastReadAt: now },
  })

  return { conversationId, lastReadAt: now.toISOString() }
}



export async function listMessagesData(userId: string, conversationId: string, page: number, pageSize: number) {
  const conversation = await ensureConversationMember(userId, conversationId)

  const total = await prisma.message.count({
    where: { conversationId },
  })
  // 倒序分页：page 1 = 最新 pageSize 条（聊天窗口默认落在最新对话），page 2 起往前翻历史；
  // 取回后反转回时间正序供前端直接渲染（此前正序 skip 导致长会话永远看不到最新消息）
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
  const items = rows.reverse()

  const [conversationPayload] = await attachDirectFollowRelations([toConversation(conversation, userId)], userId)

  return {
    conversation: conversationPayload,
    items: await attachMessageCards(items.map(toMessage)),
    pagination: buildPagination(page, pageSize, total),
  }
}



export async function sendMessageData(userId: string, conversationId: string, input: SendMessageRequest): Promise<Message | null> {
  await assertGovernanceAllowed(userId, 'direct_message')
  const conversation = await ensureConversationMember(userId, conversationId)
  ensureNonEmptyText(input.content, 'content')

  // 防骚扰：未互关的直聊属于陌生消息，单方最多发 3 条，互关后不限
  if (conversation.type === 'direct') {
    const counterpart = conversation.members.find((member) => member.userId !== userId)

    if (counterpart) {
      const followBondCount = await prisma.userFollow.count({
        where: {
          OR: [
            { followerId: userId, followingId: counterpart.userId },
            { followerId: counterpart.userId, followingId: userId },
          ],
        },
      })

      if (followBondCount < 2) {
        const sentCount = await prisma.message.count({
          where: { conversationId, senderId: userId },
        })

        if (sentCount >= 3) {
          throw new DataAccessError(
            403,
            'STRANGER_MESSAGE_LIMIT',
            '你们还没有互相关注，最多只能发送 3 条陌生消息，等对方回关后再继续聊吧。',
          )
        }
      }
    }
  }

  const message = await prisma.$transaction(async (tx) => {
    // 图片消息：前端传 base64 数据 URL，落盘后正文只存图片地址，避免数据库膨胀
    const content = input.type === 'image' ? await storeMessageImageDataUrl(input.content) : input.content
    const created = await tx.message.create({
      data: {
        conversationId,
        senderId: userId,
        type: input.type,
        content,
        relatedId: input.relatedId ?? null,
      },
    })

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        // 预览列为 VarChar(240)：图片用占位文案，长文本截断防溢出
        lastMessagePreview: input.type === 'image' ? '[图片]' : input.content.slice(0, 200),
        lastMessageAt: created.createdAt,
      },
    })

    return created
  })

  // 回填卡片富数据：发送方乐观替换 pending 消息时直接拿到可渲染的卡片
  const [withCard] = await attachMessageCards([toMessage(message)])
  return withCard
}
