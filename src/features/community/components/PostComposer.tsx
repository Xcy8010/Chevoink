import { BookOpen, Globe2, Hash, ImagePlus, PenSquare, Plus, Sparkles, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'

import { useDevice } from '@/components/layout/device-context'
import AuthPromptDialog from '@/components/ui/AuthPromptDialog'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { listRecommendedTopics } from '@/features/community/api'
import Avatar from '@/features/community/components/Avatar'
import { communityPrompts } from '@/features/community/constants'
import { MAX_POST_IMAGE_COUNT, preparePostImage } from '@/features/community/post-image'
import type { CommunityShareDraft } from '@/features/community/share'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import { splitContentByTopics } from '../../../../shared/contracts/index.js'

type PostComposerProps = {
  onSubmit: (payload: {
    content: string
    imageDataUrls?: string[]
    relatedNovelId?: string
    sharedUserId?: string
  }) => Promise<boolean>
  isSubmitting: boolean
  /** 从作品页/作者页带入的分享草稿：自动展开编辑器并预览卡片 */
  initialShare?: CommunityShareDraft | null
}

/**
 * 发帖入口（方案 8.3.2 / 18 §3.5）：
 * - 从社区工具栏打开发布编辑器
 * - 实色居中模态，两端共享编辑区与工具栏，键盘弹起时收紧可视高度
 * - 话题改用 X 式 # 语法：正文内 #话题 由服务端解析，不再选话题按钮
 */
export default function PostComposer({ onSubmit, isSubmitting, initialShare }: PostComposerProps) {
  const { isMobile } = useDevice()
  const toast = useToast()
  const authStatus = useShellStore((state) => state.authStatus)
  const user = useShellStore(state => state.sessionUser)
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [closing, setClosing] = useState(false)
  const [helper, setHelper] = useState<'topics' | 'prompts' | null>(null)
  const [open, setOpen] = useState(false)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const [content, setContent] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [imageProcessing, setImageProcessing] = useState(false)
  const [share, setShare] = useState<CommunityShareDraft | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // #话题 高亮镜像层：textarea 文字透明，同字体同内边距的镜像层负责渲染彩色正文
  const highlightLayerRef = useRef<HTMLDivElement | null>(null)

  // 推荐话题：打开编辑器才拉，点击直接插入光标处
  const recommendedTopicsQuery = useQuery({
    queryKey: ['community', 'recommended-topics'],
    queryFn: listRecommendedTopics,
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })
  const recommendedTopics = recommendedTopicsQuery.data?.items ?? []

  // 带分享草稿进入时自动展开编辑器（未登录保持收起，点假输入框会引导去登录）
  useEffect(() => {
    if (!initialShare) return
    setShare(initialShare)
    if (authStatus === 'authenticated') {
      setOpen(true)
    }
  }, [initialShare, authStatus])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      setClosing(false)
      if (!dialog.open) dialog.showModal()
      return
    }
    if (!dialog.open) return
    setClosing(true)
    const timer = window.setTimeout(() => {
      dialog.close()
      setClosing(false)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const root = dialogRef.current?.closest<HTMLElement>('[data-app-main-scroll]')
    if (!root) return
    const previousOverflow = root.style.overflowY
    root.style.overflowY = 'hidden'
    return () => { root.style.overflowY = previousOverflow }
  }, [open])

  const handleOpen = () => {
    if (authStatus !== 'authenticated') {
      // 未登录不再生硬跳页，弹窗引导去登录/注册，关掉后留在社区继续浏览
      setAuthPromptOpen(true)
      return
    }
    setOpen(true)
  }

  const handleClose = () => {
    if (!isSubmitting) setOpen(false)
  }

  /** textarea 滚动时镜像层同步位移，保证 #话题 高亮与正文逐字对齐 */
  const handleEditorScroll = () => {
    const textarea = textareaRef.current
    const layer = highlightLayerRef.current
    if (textarea && layer) {
      layer.scrollTop = textarea.scrollTop
    }
  }

  /** 推荐话题点击：把 #话题 插入光标处，光标落在插入内容之后 */
  const handleInsertTopic = (name: string) => {
    const tag = `#${name} `
    const textarea = textareaRef.current
    if (!textarea) {
      setContent((value) => `${value}${tag}`)
      return
    }

    const start = textarea.selectionStart ?? content.length
    const end = textarea.selectionEnd ?? start
    setContent(`${content.slice(0, start)}${tag}${content.slice(end)}`)
    requestAnimationFrame(() => {
      textarea.focus()
      const caret = start + tag.length
      textarea.setSelectionRange(caret, caret)
    })
  }

  /** 选图后逐张校验+压缩，超出 9 张的部分直接舍弃并提示 */
  const handlePickImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || imageProcessing) return

    const remaining = MAX_POST_IMAGE_COUNT - images.length
    if (remaining <= 0) {
      toast.error(`最多上传 ${MAX_POST_IMAGE_COUNT} 张图片`)
      return
    }

    if (files.length > remaining) {
      toast.error(`最多上传 ${MAX_POST_IMAGE_COUNT} 张图片，已为你保留前 ${remaining} 张`)
    }

    setImageProcessing(true)
    try {
      const prepared: string[] = []
      for (const file of files.slice(0, remaining)) {
        try {
          prepared.push(await preparePostImage(file))
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '图片处理失败，请换一张再试')
        }
      }
      if (prepared.length) {
        setImages((value) => [...value, ...prepared].slice(0, MAX_POST_IMAGE_COUNT))
      }
    } finally {
      setImageProcessing(false)
    }
  }

  const handleRemoveImage = (index: number) => {
    setImages((value) => value.filter((_, itemIndex) => itemIndex !== index))
  }

  const handleSubmit = async () => {
    const trimmed = content.trim()
    if (!trimmed || isSubmitting || imageProcessing) return
    const published = await onSubmit({
      content: trimmed,
      imageDataUrls: images,
      relatedNovelId: share?.kind === 'novel' ? share.novel.id : undefined,
      sharedUserId: share?.kind === 'author' ? share.author.id : undefined,
    })
    if (!published) return
    setContent('')
    setImages([])
    setShare(null)
    setOpen(false)
  }

  const editor = (
    <div className="flex min-h-0 flex-col">
      {/* 高亮镜像结构：镜像层垫底渲染彩色正文（#话题 品牌蓝），textarea 叠在上层、
          文字透明只留光标，滚动时同步镜像层位移，两端指标一致保证逐行对齐 */}
      <div className="relative h-44 shrink-0 md:h-52">
        <div
          ref={highlightLayerRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-4 text-lg leading-7 text-[var(--text-primary)] md:px-5"
        >
          {splitContentByTopics(content).map((segment, index) =>
            segment.type === 'topic' ? (
              <span key={index} className="text-[var(--color-brand)]">
                {segment.text}
              </span>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
          {/* 尾部补一个换行：正文以 \n 结尾时 textarea 仍占一行，镜像层保持同高 */}
          {'\n'}
        </div>
        <textarea
          ref={textareaRef}
          // 手机先居中展示弹窗，用户点正文后再唤起键盘。
          autoFocus={!isMobile}
          readOnly={isSubmitting}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onScroll={handleEditorScroll}
          aria-label="帖子内容"
          placeholder={share ? '说说你的推荐理由，让更多人看到它。' : '分享你的新鲜事吧…'}
          // 绝对定位铺满容器，与镜像层同尺寸同内边距，逐行对齐
          className="absolute inset-0 h-full w-full resize-none border-0 bg-transparent whitespace-pre-wrap break-words px-4 py-4 text-lg leading-7 text-transparent caret-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] md:px-5"
        />
      </div>

      {/* 分享卡片预览：不可点跳转，右上角可移除 */}
      {share ? (
        <div className="px-4 pb-3 md:px-5">
          <div className="relative flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3 pr-11">
            {share.kind === 'novel' ? (
              <>
                {share.novel.coverUrl ? (
                  <img
                    src={share.novel.coverUrl}
                    alt={share.novel.title}
                    className="h-16 w-12 shrink-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-default)] text-[var(--text-tertiary)]">
                    <BookOpen className="h-5 w-5" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--text-tertiary)]">分享作品</p>
                  <p className="mt-1 line-clamp-1 text-sm font-medium text-[var(--text-primary)]">
                    {share.novel.title}
                  </p>
                </div>
              </>
            ) : (
              <>
                <Avatar name={share.author.nickname} src={share.author.avatarUrl} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--text-tertiary)]">推荐作者</p>
                  <p className="mt-1 line-clamp-1 text-sm font-medium text-[var(--text-primary)]">
                    {share.author.nickname}
                  </p>
                  {share.author.bio ? (
                    <p className="mt-0.5 line-clamp-1 text-xs text-[var(--text-tertiary)]">{share.author.bio}</p>
                  ) : null}
                </div>
              </>
            )}
            <button
              type="button"
              onClick={() => setShare(null)}
              aria-label="移除分享卡片"
              disabled={isSubmitting}
              className="press-feedback absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-default)] hover:text-[var(--text-primary)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {/* 配图预览：小缩略图行（位于输入框下方），避免大图撑高输入区、遮挡底部发布栏 */}
      {images.length > 0 || imageProcessing ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3 md:px-5">
          {images.map((dataUrl, index) => (
            <div
              key={`${index}-${dataUrl.slice(-24)}`}
              className="relative h-20 w-20 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)]"
            >
              <img src={dataUrl} alt={`配图 ${index + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => handleRemoveImage(index)}
                aria-label={`移除第 ${index + 1} 张配图`}
                disabled={isSubmitting}
                className="press-feedback absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {imageProcessing ? (
            <div className="flex h-20 w-20 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] text-xs text-[var(--text-tertiary)]">
              处理中...
            </div>
          ) : null}
        </div>
      ) : null}

      {helper ? (
        <div className="px-4 pb-4 md:px-5">
          {helper === 'topics' ? (
            <div className="space-y-2">
              <p className="text-xs text-[var(--text-tertiary)]">使用 # 引用或创建话题，话题名最多 9 个字</p>
              <div className="flex flex-wrap gap-2">
                {recommendedTopics.map(topic => <button key={topic.id} type="button" disabled={isSubmitting} onClick={() => handleInsertTopic(topic.name)} className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--color-brand)] hover:opacity-80">#{topic.name}</button>)}
              </div>
            </div>
          ) : (
            <div className="grid gap-1">
              {communityPrompts.map(prompt => <button key={prompt} type="button" disabled={isSubmitting} onClick={() => { setContent(value => value ? value + '\n' + prompt : prompt); setHelper(null); textareaRef.current?.focus() }} className="rounded-lg px-2 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]">{prompt}</button>)}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="发帖"
        title="发帖"
        data-community-compose
        className="press-feedback touch-target fixed bottom-[calc(var(--safe-bottom)+82px)] right-[calc(env(safe-area-inset-right,0px)+16px)] z-[41] grid h-14 w-14 place-items-center rounded-full bg-[var(--color-brand)] text-[var(--text-contrast)] shadow-[0_4px_18px_rgba(0,0,0,0.18)] transition-colors hover:bg-[var(--color-brand-hover)] md:bottom-[calc(var(--safe-bottom)+24px)] md:right-[calc(env(safe-area-inset-right,0px)+24px)] md:border md:border-[var(--border-subtle)] md:bg-[var(--surface-default)] md:text-[var(--text-primary)] md:hover:bg-[var(--surface-muted)]"
      >
        <Plus className="h-7 w-7 md:hidden" aria-hidden />
        <PenSquare className="hidden h-6 w-6 md:block" aria-hidden />
      </button>

      {/* 未登录发帖拦截弹窗 */}
      <AuthPromptDialog
        open={authPromptOpen}
        description="登录或注册后，就可以发布讨论、参与话题并和大家互动。"
        onClose={() => setAuthPromptOpen(false)}
      />

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        data-state={closing ? 'closing' : 'open'}
        className="post-composer-dialog"
        onCancel={event => { event.preventDefault(); handleClose() }}
        onClick={event => { if (event.target === event.currentTarget) handleClose() }}
      >
        <div className="post-composer-frame">
          <header className="relative flex h-16 shrink-0 items-center justify-center border-b border-[var(--border-subtle)] px-16">
            <h2 id={titleId} className="text-lg font-semibold">发帖</h2>
            <button type="button" onClick={handleClose} aria-label="关闭发帖" disabled={isSubmitting} className="absolute right-3 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"><X className="h-5 w-5" /></button>
          </header>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <div className="flex items-center gap-3 px-4 pt-4 md:px-5">
              <Avatar name={user?.nickname ?? '我'} src={user?.avatarUrl} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{user?.nickname ?? '我'}</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]"><Globe2 className="h-3 w-3" />公开</span>
              </div>
            </div>
            {editor}
          </div>
          <footer className="shrink-0 space-y-3 px-4 pb-4 pt-2 md:px-5 md:pb-5">
            <div className="flex min-h-16 items-center justify-between gap-2 rounded-xl border border-[var(--border-strong)] px-3">
              <span className="shrink-0 text-sm font-medium">添加到帖子</span>
              <div className="flex items-center gap-1">
                <button type="button" title="添加图片" aria-label="添加图片" onClick={() => imageInputRef.current?.click()} disabled={isSubmitting || imageProcessing || images.length >= MAX_POST_IMAGE_COUNT} className="grid h-11 w-11 place-items-center rounded-full text-[var(--color-success)] hover:bg-[var(--surface-muted)] disabled:opacity-40"><ImagePlus className="h-6 w-6" /></button>
                <button type="button" title="添加话题" aria-label="添加话题" aria-expanded={helper === 'topics'} onClick={() => setHelper(value => value === 'topics' ? null : 'topics')} disabled={isSubmitting} className={cn('grid h-11 w-11 place-items-center rounded-full text-[var(--color-info)] hover:bg-[var(--surface-muted)]', helper === 'topics' && 'bg-[var(--surface-muted)]')}><Hash className="h-6 w-6" /></button>
                <button type="button" title="写作灵感" aria-label="写作灵感" aria-expanded={helper === 'prompts'} onClick={() => setHelper(value => value === 'prompts' ? null : 'prompts')} disabled={isSubmitting} className={cn('grid h-11 w-11 place-items-center rounded-full text-[var(--color-warning)] hover:bg-[var(--surface-muted)]', helper === 'prompts' && 'bg-[var(--surface-muted)]')}><Sparkles className="h-6 w-6" /></button>
              </div>
            </div>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={event => void handlePickImages(event)} />
            {images.length || imageProcessing ? <p className="text-xs text-[var(--text-tertiary)]">{imageProcessing ? '正在处理图片…' : images.length + ' / ' + MAX_POST_IMAGE_COUNT + ' 张图片'}</p> : null}
            <Button variant="primary" className="h-11 w-full rounded-lg bg-[var(--color-brand)] text-[var(--text-contrast)] hover:bg-[var(--color-brand-hover)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-tertiary)] disabled:opacity-100" onClick={() => void handleSubmit()} disabled={!content.trim() || isSubmitting || imageProcessing}>{isSubmitting ? '发布中' : '发布讨论'}</Button>
          </footer>
        </div>
      </dialog>
    </>
  )
}
