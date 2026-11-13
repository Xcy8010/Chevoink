import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { StudioSkeleton } from '@/components/ui/Skeleton'
import { getMe } from '@/features/community/api'
import { createNovelWorkspace } from '@/features/studio/api'
import StudioOpenError from '@/features/studio/components/StudioOpenError'
import StudioWorkspace from '@/features/studio/StudioWorkspace'
import type { Novel, UserMePayload } from '../../shared/contracts/index.js'

const INITIAL_NOVEL_TITLE = '未命名作品'
const INITIAL_NOVEL_SUMMARY = '先创建一部作品，再继续完善简介、章节和封面。'
const STUDIO_LAST_NOVEL_STORAGE_KEY = 'studio-last-novel-id'

export default function StudioPage() {
  const { novelId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const bootstrapRequestedRef = useRef(false)

  const meQuery = useQuery({
    queryKey: ['community', 'me'],
    queryFn: getMe,
    enabled: !novelId,
    refetchOnWindowFocus: false,
  })

  const createNovelMutation = useMutation({
    mutationFn: () =>
      createNovelWorkspace({
        title: INITIAL_NOVEL_TITLE,
        summary: INITIAL_NOVEL_SUMMARY,
        tags: [],
        visibility: 'private',
        status: 'draft',
      }),
    onSuccess: (novel) => {
      window.localStorage.setItem(STUDIO_LAST_NOVEL_STORAGE_KEY, novel.id)
      queryClient.setQueryData<UserMePayload>(['community', 'me'], (current) => {
        if (!current) {
          return current
        }

        const currentAuthoredNovels = Array.isArray(current.authoredNovels) ? current.authoredNovels : []
        return {
          ...current,
          authoredNovels: [novel as Novel, ...currentAuthoredNovels.filter((item) => item.id !== novel.id)],
        }
      })
      void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      navigate(`/studio/novel/${novel.id}`, { replace: true })
    },
  })

  const studioEntryNovelId = useMemo(() => {
    const authoredNovels = [...(meQuery.data?.authoredNovels ?? [])].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )
    const draftNovelId = meQuery.data?.drafts?.[0]?.novelId ?? null
    const draftNovel = authoredNovels.find((item) => item.id === draftNovelId) ?? null
    const lastNovelId =
      typeof window !== 'undefined' ? window.localStorage.getItem(STUDIO_LAST_NOVEL_STORAGE_KEY) : null
    const lastNovel =
      lastNovelId ? authoredNovels.find((item) => item.id === lastNovelId) ?? null : null

    if (lastNovel) {
      return lastNovel.id
    }

    if (draftNovel) {
      return draftNovel.id
    }

    if (authoredNovels[0]) {
      return authoredNovels[0].id
    }

    if (draftNovelId) {
      return draftNovelId
    }

    if (!meQuery.data?.user?.id) {
      return null
    }

    return null
  }, [meQuery.data?.authoredNovels, meQuery.data?.drafts, meQuery.data?.user?.id])

  useEffect(() => {
    if (novelId) {
      return
    }

    if (!meQuery.isSuccess || !studioEntryNovelId) {
      return
    }

    navigate(`/studio/novel/${studioEntryNovelId}`, { replace: true })
  }, [meQuery.isSuccess, navigate, novelId, studioEntryNovelId])

  // 零作品用户直接进入完整 Agent 工作台。占位作品不会出现在公开作品列表中，
  // 首次真正发送后由 Agent 按提示补齐书名、简介与标签；示例点击本身不会创建额外作品。
  useEffect(() => {
    if (novelId || !meQuery.isSuccess || studioEntryNovelId || createNovelMutation.isPending || createNovelMutation.isSuccess || bootstrapRequestedRef.current) {
      return
    }
    bootstrapRequestedRef.current = true
    createNovelMutation.mutate()
  }, [createNovelMutation, meQuery.isSuccess, novelId, studioEntryNovelId])

  if (novelId) {
    return <StudioWorkspace />
  }

  if (meQuery.isError) {
    return (
      <StudioOpenError error={meQuery.error} retry={() => meQuery.refetch()} />
    )
  }

  if (createNovelMutation.isError) {
    return (
      <StudioOpenError
        error={createNovelMutation.error}
        title="新建作品暂时失败"
        retryLabel="重新创建"
        retry={() => {
          createNovelMutation.reset()
          return createNovelMutation.mutateAsync()
        }}
      />
    )
  }

  return <StudioSkeleton />
}
