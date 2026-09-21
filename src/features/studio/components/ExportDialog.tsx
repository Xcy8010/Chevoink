import { useEffect, useMemo, useState } from 'react'
import { Check, CircleAlert, FolderDown, LoaderCircle, X } from 'lucide-react'

import { useToast } from '@/components/ui/toast-context'
import { isNativeApp } from '@/lib/native-app'
import { cn } from '@/lib/utils'
import type { ChapterListItem } from '../../../../shared/contracts/index.js'

import {
  downloadNovelExportZip,
  openExportDownloadInBrowser,
  requestNovelExportLink,
  type NovelExportRequest,
} from '../lib/export-download'

type ExportDialogProps = {
  open: boolean
  novelId: string
  novelTitle: string
  chapters: ChapterListItem[]
  onClose: () => void
}

type SectionKey = 'plans' | 'memories' | 'catalog' | 'chapters' | 'info'

const SECTION_OPTIONS: Array<{ key: SectionKey; label: string; hint: string }> = [
  { key: 'plans', label: '规划', hint: '计划文件夹内的全部创作计划' },
  { key: 'memories', label: '创作记忆', hint: '当前作品的创作记忆，逐条保存为 txt' },
  { key: 'catalog', label: '目录', hint: '全部章节的目录清单' },
  { key: 'chapters', label: '章节', hint: '各章正文，按卷分文件夹逐章存为 txt' },
  { key: 'info', label: '作品信息以及发布建议', hint: '作品信息 + AI 生成的番茄小说发布建议与封面图片' },
]

function CheckboxRow({
  checked,
  label,
  hint,
  onToggle,
}: {
  checked: boolean
  label: string
  hint?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-start gap-3 rounded-[14px] px-3 py-2.5 text-left transition hover:bg-[var(--surface-muted)]"
    >
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition',
          checked
            ? 'border-[var(--surface-contrast)] bg-[var(--surface-contrast)] text-[var(--text-contrast)]'
            : 'border-[var(--border-strong)] bg-transparent text-transparent',
        )}
      >
        <Check className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-[var(--text-primary)]">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-5 text-[var(--text-tertiary)]">{hint}</span> : null}
      </span>
    </button>
  )
}

/** 一键导出弹窗：勾选内容，章节支持全量或按章自选，确认后服务端打包 zip 直接下载 */
export default function ExportDialog({ open, novelId, novelTitle, chapters, onClose }: ExportDialogProps) {
  const toast = useToast()
  const [sections, setSections] = useState<Record<SectionKey, boolean>>({
    plans: true,
    memories: true,
    catalog: true,
    chapters: true,
    info: true,
  })
  const [chapterMode, setChapterMode] = useState<'all' | 'custom'>('all')
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  // 额度用尽兑底提示：导出本身成功，仅作品建议未包含（用户要求自定义弹窗而非 toast）
  const [creditsNoticeOpen, setCreditsNoticeOpen] = useState(false)

  // 每次打开重置为「全部导出」，避免沿用上次勾选造成意外裁剪
  useEffect(() => {
    if (open) {
      setSections({ plans: true, memories: true, catalog: true, chapters: true, info: true })
      setChapterMode('all')
      setSelectedChapterIds([])
      setExporting(false)
      setCreditsNoticeOpen(false)
    }
  }, [open])

  const allChapterIds = useMemo(() => chapters.map((chapter) => chapter.id), [chapters])
  const customValid = chapterMode === 'all' || selectedChapterIds.length > 0
  const anySectionChecked = Object.values(sections).some(Boolean)
  const canExport = anySectionChecked && (!sections.chapters || customValid) && !exporting

  if (!open) return null

  const toggleSection = (key: SectionKey) => {
    setSections((current) => ({ ...current, [key]: !current[key] }))
  }

  const toggleChapter = (chapterId: string) => {
    setSelectedChapterIds((current) =>
      current.includes(chapterId) ? current.filter((id) => id !== chapterId) : [...current, chapterId],
    )
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const options: NovelExportRequest = {
        includePlans: sections.plans,
        includeMemories: sections.memories,
        includeCatalog: sections.catalog,
        includeInfo: sections.info,
        includeChapters: sections.chapters,
        chapterIds: sections.chapters && chapterMode === 'custom' ? selectedChapterIds : undefined,
      }

      if (isNativeApp()) {
        // APP 壳内 WebView 会吞掉 blob 下载（下载了也找不到文件）：
        // 服务端打包暂存后拿一次性链接，外跳系统浏览器完成保存
        const link = await requestNovelExportLink(novelId, options)
        openExportDownloadInBrowser(link.downloadUrl)
        toast.success('导出打包完成，已跳转系统浏览器下载，完成后请查看手机「下载」文件夹。')
        if (link.adviceCreditsExhausted) {
          setExporting(false)
          setCreditsNoticeOpen(true)
          return
        }
      } else {
        const adviceCreditsExhausted = await downloadNovelExportZip(novelId, options)
        toast.success('导出完成，文件已开始下载。')
        if (adviceCreditsExhausted) {
          setExporting(false)
          setCreditsNoticeOpen(true)
          return
        }
      }

      onClose()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : '导出失败，请稍后重试。')
      setExporting(false)
    }
  }

  return (
    <div className="studio-workspace fixed inset-0 z-[130] flex items-end justify-center bg-[rgba(15,23,42,0.45)] p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-[24px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[var(--shadow-soft)] sm:rounded-[24px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <FolderDown className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">一键导出</h3>
            <p className="truncate text-xs text-[var(--text-tertiary)]">《{novelTitle}》将以 zip 打包下载</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭导出弹窗"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--surface-muted)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          <p className="px-3 pb-1 text-xs font-medium text-[var(--text-tertiary)]">导出内容</p>
          <div className="space-y-0.5">
            {SECTION_OPTIONS.map((option) => (
              <CheckboxRow
                key={option.key}
                checked={sections[option.key]}
                label={option.label}
                hint={option.hint}
                onToggle={() => toggleSection(option.key)}
              />
            ))}
          </div>

          {sections.chapters && chapters.length > 0 ? (
            <div className="mt-3 rounded-[14px] border border-[var(--border-subtle)]">
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">
                  章节范围（共 {chapters.length} 章）
                </p>
                <div className="flex items-center gap-1.5">
                  {(['all', 'custom'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setChapterMode(mode)
                        if (mode === 'custom' && selectedChapterIds.length === 0) {
                          setSelectedChapterIds(allChapterIds)
                        }
                      }}
                      className={cn(
                        'rounded-full px-3 py-1 text-xs transition',
                        chapterMode === mode
                          ? 'bg-[var(--surface-contrast)] font-medium text-[var(--text-contrast)]'
                          : 'bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]/70',
                      )}
                    >
                      {mode === 'all' ? '全部章节' : '自选章节'}
                    </button>
                  ))}
                </div>
              </div>
              {chapterMode === 'custom' ? (
                <div className="scrollbar-none max-h-56 overflow-y-auto overscroll-contain p-1.5">
                  <div className="flex items-center justify-between px-2 pb-1">
                    <p className="text-[11px] text-[var(--text-tertiary)]">已选 {selectedChapterIds.length} 章</p>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedChapterIds(selectedChapterIds.length === allChapterIds.length ? [] : allChapterIds)
                      }
                      className="text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:underline"
                    >
                      {selectedChapterIds.length === allChapterIds.length ? '全部取消' : '全部选中'}
                    </button>
                  </div>
                  {chapters.map((chapter, index) => (
                    <CheckboxRow
                      key={chapter.id}
                      checked={selectedChapterIds.includes(chapter.id)}
                      label={`第${index + 1}章 ${chapter.title}`}
                      hint={`${chapter.wordCount} 字 · ${chapter.status === 'published' ? '已发布' : '草稿'}`}
                      onToggle={() => toggleChapter(chapter.id)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center rounded-full px-4 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--surface-muted)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canExport}
            onClick={() => void handleExport()}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--surface-contrast)] px-5 text-sm font-medium text-[var(--text-contrast)] transition hover:bg-[var(--surface-contrast-hover)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderDown className="h-4 w-4" />}
            {exporting ? '正在打包导出' : '开始导出'}
          </button>
        </div>
      </div>

      {creditsNoticeOpen ? (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-6" onClick={() => { setCreditsNoticeOpen(false); onClose() }}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="额度提示"
            className="w-full max-w-sm rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.24)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <CircleAlert className="h-5 w-5 shrink-0 text-amber-500" />
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">当前额度已用尽</h4>
            </div>
            <p className="mt-3 text-xs leading-6 text-[var(--text-secondary)]">
              当前额度已用尽，一键导出内无法包含作品建议；其它内容（规划、目录、章节等）已正常导出下载。
              额度恢复或充值后可重新导出，即可包含 AI 生成的作品建议。
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => { setCreditsNoticeOpen(false); onClose() }}
                className="inline-flex h-9 items-center rounded-full bg-[var(--surface-contrast)] px-5 text-xs font-medium text-[var(--text-contrast)] transition hover:bg-[var(--surface-contrast-hover)]"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
