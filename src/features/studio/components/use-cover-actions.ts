import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'
import { useToast } from '@/components/ui/toast-context'
import { updateShelfCover } from '@/features/home/local-shelf'
import { FIXED_NOVEL_COVER_SIZE, type CoverAsset, type Novel, type StudioPayload } from '../../../../shared/contracts/index.js'
import { generateCoverImages, generateCoverPrompt, uploadNovelCover, updateNovelMeta } from '../api'
import { buildFixedNovelCoverDataUrl, type NovelCoverCropState } from '../cover-image'
import type { CoverFormState, MobileView, ToolPanel } from '../types'

type CoverActions = {
  activeNovelId: string
  currentNovel: Novel | null
  coverForm: CoverFormState | null
  pendingCoverUploadFile: File | null
  setCoverForm: Dispatch<SetStateAction<CoverFormState | null>>
  setCoverKeywords: Dispatch<SetStateAction<string[]>>
  setCoverMessage: Dispatch<SetStateAction<string>>
  setActiveToolPanel: Dispatch<SetStateAction<ToolPanel | null>>
  setMobileView: Dispatch<SetStateAction<MobileView>>
  setCoverAssets: Dispatch<SetStateAction<CoverAsset[]>>
  setSelectedCoverId: Dispatch<SetStateAction<string | null>>
  setWorkspaceDialog: (dialog: { title: string; description: string; confirmLabel?: string; cancelLabel?: string; onConfirm: () => void }) => void
  setCoverGenerationBusy: Dispatch<SetStateAction<boolean>>
  setCurrentNovel: Dispatch<SetStateAction<Novel | null>>
  setPendingCoverUploadFile: Dispatch<SetStateAction<File | null>>
  syncStudioPayload: (updater: (current: StudioPayload | undefined) => StudioPayload | undefined) => void
}

/** Cover API mutations and cache propagation, independent from editor/layout orchestration. */
export function useCoverActions({
  activeNovelId, currentNovel, coverForm, pendingCoverUploadFile, setCoverForm, setCoverKeywords, setCoverMessage, setActiveToolPanel, setMobileView, setCoverAssets, setSelectedCoverId, setWorkspaceDialog, setCoverGenerationBusy, setCurrentNovel, setPendingCoverUploadFile, syncStudioPayload,
}: CoverActions) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const coverPromptMutation = useMutation({
    mutationFn: async () => {
      if (!coverForm) {
        throw new Error('封面参数尚未准备完成')
      }

      return generateCoverPrompt({
        novelId: activeNovelId,
        novelTitle: coverForm.novelTitle.trim(),
        summary: coverForm.summary.trim(),
        genre: coverForm.genre.trim(),
        protagonist: coverForm.protagonist.trim() || undefined,
        stylePreference: coverForm.stylePreference.trim() || undefined,
      })
    },
    onSuccess: (result) => {
      setCoverForm((current) =>
        current
          ? {
              ...current,
              prompt: result.prompt,
              negativePrompt: result.negativePrompt ?? '',
            }
          : current,
      )
      setCoverKeywords(result.visualKeywords)
      setCoverMessage('提示词已生成，可继续微调后再生成封面。')
      toast.success('封面提示词已生成，可继续微调后直接生成封面。')
      setActiveToolPanel('cover')
      setMobileView('cover')
    },
    onError: (error: Error) => {
      setCoverMessage(error.message)
      toast.error(error.message || '封面提示词生成失败，请稍后重试。')
    },
  })

  const coverImageMutation = useMutation({
    mutationFn: async () => {
      if (!coverForm?.prompt.trim()) {
        throw new Error('请先生成或补充封面提示词。')
      }

      return generateCoverImages({
        prompt: coverForm.prompt,
        size: FIXED_NOVEL_COVER_SIZE,
        count: coverForm.count,
        novelId: activeNovelId,
      })
    },
    onSuccess: (result) => {
      setCoverAssets((current) => [...result.images, ...current])
      setSelectedCoverId(result.images[0]?.id ?? null)
      setCoverMessage(`候选封面已生成 ${result.images.length} 张，可先预览再设为正式封面。`)
      setActiveToolPanel('cover')
      setMobileView('cover')
      syncStudioPayload((current) =>
        current ? { ...current, coverAssets: [...result.images, ...current.coverAssets] } : current,
      )
      if (result.images.length > 0) {
        setWorkspaceDialog({
          title: '封面生成完成',
          description: `已经生成 ${result.images.length} 张封面候选图。现在可以去查看、下载，或者一键设为作品封面。`,
          confirmLabel: '去查看',
          cancelLabel: '稍后',
          onConfirm: () => {
            setActiveToolPanel('cover')
            setMobileView('cover')
          },
        })
      }
    },
    onError: (error: Error) => {
      setCoverMessage(error.message)
    },
    onMutate: () => {
      setCoverGenerationBusy(true)
    },
    onSettled: () => {
      setCoverGenerationBusy(false)
    },
  })

  const coverUploadMutation = useMutation({
    mutationFn: async (crop: NovelCoverCropState) => {
      if (!currentNovel) {
        throw new Error('作品信息尚未加载完成。')
      }

      if (!pendingCoverUploadFile) {
        throw new Error('还没有选择要上传的封面图片。')
      }

      const coverDataUrl = await buildFixedNovelCoverDataUrl(pendingCoverUploadFile, crop)
      return uploadNovelCover(currentNovel.id, { coverDataUrl })
    },
    onSuccess: ({ novel, asset }) => {
      setCoverAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)])
      setSelectedCoverId(asset.id)
      setCurrentNovel((current) =>
        current
          ? {
              ...novel,
              coverUrl: asset.imageUrl,
              coverAssetId: asset.id,
            }
          : current,
      )
      setCoverMessage('本地封面已按固定书封比例上传，并设为当前作品封面。')
      setActiveToolPanel('cover')
      setMobileView('cover')
      // 封面更换后同步本机书架快照与站内缓存列表，避免书架/收藏/详情继续显示旧封面
      updateShelfCover(novel.id, asset.imageUrl)
      void queryClient.invalidateQueries({ queryKey: ['novel-detail', novel.id] })
      void queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
      void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      void queryClient.invalidateQueries({ queryKey: ['home'] })
      syncStudioPayload((current) =>
        current
          ? {
              ...current,
              novel: {
                ...current.novel,
                ...novel,
                coverUrl: asset.imageUrl,
                coverAssetId: asset.id,
              },
              coverAssets: [asset, ...current.coverAssets.filter((item) => item.id !== asset.id)],
            }
          : current,
      )
    },
    onSettled: () => {
      setPendingCoverUploadFile(null)
    },
    onError: (error: Error) => {
      setCoverMessage(error.message)
    },
  })

  const coverSelectMutation = useMutation({
    mutationFn: async (asset: CoverAsset) => {
      if (!currentNovel) {
        throw new Error('作品信息尚未加载完成')
      }

      return updateNovelMeta(currentNovel.id, {
        coverAssetId: asset.id,
        coverPrompt: coverForm?.prompt.trim() || asset.prompt,
      })
    },
    onSuccess: (updatedNovel, asset) => {
      setCurrentNovel((current) =>
        current
          ? {
              ...updatedNovel,
              coverUrl: asset.imageUrl,
              coverAssetId: asset.id,
            }
          : current,
      )
      setSelectedCoverId(asset.id)
      setCoverMessage('作品封面已更新。')
      // 封面更换后同步本机书架快照与站内缓存列表，避免书架/收藏/详情继续显示旧封面
      updateShelfCover(updatedNovel.id, asset.imageUrl)
      void queryClient.invalidateQueries({ queryKey: ['novel-detail', updatedNovel.id] })
      void queryClient.invalidateQueries({ queryKey: ['studio', 'my-novels'] })
      void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      void queryClient.invalidateQueries({ queryKey: ['home'] })
      syncStudioPayload((current) =>
        current
          ? {
              ...current,
              novel: {
                ...current.novel,
                ...updatedNovel,
                coverUrl: asset.imageUrl,
                coverAssetId: asset.id,
              },
            }
          : current,
      )
    },
    onError: (error: Error) => {
      setCoverMessage(error.message)
    },
  })

  return { coverPromptMutation, coverImageMutation, coverUploadMutation, coverSelectMutation }
}
