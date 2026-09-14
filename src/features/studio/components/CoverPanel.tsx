import { Check, Download, ImagePlus, LoaderCircle, PenLine, Sparkles, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

import Button from '@/components/ui/Button'
import Tag from '@/components/ui/Tag'
import { FIXED_NOVEL_COVER_HEIGHT, FIXED_NOVEL_COVER_WIDTH, type CoverAsset } from '../../../../shared/contracts/index.js'

import type { CoverFormState } from '../types'
import ImageLightbox from './ImageLightbox'
import { InputLabel, SelectControl, ToolShell } from './StudioControls'

type CoverPanelProps = {
  coverForm: CoverFormState
  coverAssets: CoverAsset[]
  selectedCover: CoverAsset | null
  currentCoverId?: string | null
  coverKeywords: string[]
  coverMessage: string
  generatingPrompt: boolean
  generatingImage: boolean
  generationProgress: number
  selectingCover: boolean
  formatDateTime: (value?: string | null) => string
  onChange: (next: CoverFormState) => void
  onUploadFile: (file: File) => void
  onGeneratePrompt: () => void
  onGenerateImages: () => void
  onSelectAsset: (assetId: string | null) => void
  onApplyCover: () => void
  onApplyAsset: (asset: CoverAsset) => void
  onDownloadAsset: (asset: CoverAsset) => void
  onClose: () => void
}

export default function CoverPanel({
  coverForm,
  coverAssets,
  selectedCover,
  currentCoverId,
  coverKeywords,
  coverMessage,
  generatingPrompt,
  generatingImage,
  generationProgress,
  selectingCover,
  formatDateTime,
  onChange,
  onUploadFile,
  onGeneratePrompt,
  onGenerateImages,
  onSelectAsset,
  onApplyCover,
  onApplyAsset,
  onDownloadAsset,
  onClose,
}: CoverPanelProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  // 智能模式：一键从作品信息生成提示词；手动模式：直接编写提示词，降低上手门槛
  const [promptMode, setPromptMode] = useState<'smart' | 'manual'>('smart')
  // 点击封面图后全屏放大查看，支持下载
  const [previewAsset, setPreviewAsset] = useState<CoverAsset | null>(null)

  return (
    <ToolShell
      title="AI 封面"
      description="一键生成提示词和候选图，也可以自己写提示词或直接上传封面。"
      actions={
        <Button variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      }
    >
      <div className="scrollbar-none flex h-full min-h-0 max-w-full flex-col gap-4 overflow-y-auto overflow-x-hidden overscroll-contain">
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              onUploadFile(file)
            }
            event.target.value = ''
          }}
        />

        {/* 用 flex 纵排而非 grid 隐式 auto 列：auto 轨道会按子项 max-content 取宽，
            智能生成回填的长提示词会把 textarea 固有宽度撑大，进而横向撑开整个容器 */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* 提示词模式切换 */}
          <div className="grid grid-cols-2 gap-1 rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-1">
            {([
              ['smart', '智能生成', Sparkles],
              ['manual', '手动输入', PenLine],
            ] as const).map(([mode, label, Icon]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setPromptMode(mode)}
                className={
                  promptMode === mode
                    ? 'inline-flex min-h-10 items-center justify-center gap-2 rounded-[12px] bg-[var(--surface-default)] text-sm font-medium text-[var(--text-primary)] shadow-[var(--shadow-soft)] transition'
                    : 'inline-flex min-h-10 items-center justify-center gap-2 rounded-[12px] text-sm font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]'
                }
                aria-pressed={promptMode === mode}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          {promptMode === 'smart' ? (
            <div className="space-y-3">
              <p className="text-sm leading-6 text-[var(--text-secondary)]">
                AI 会根据书名、简介和题材自动提炼封面提示词，生成后可继续微调。
              </p>
              <Button onClick={onGeneratePrompt} variant="secondary" disabled={generatingPrompt} className="w-full justify-center">
                {generatingPrompt ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                智能生成提示词
              </Button>
              {coverForm.prompt ? (
                <label className="space-y-2">
                  <InputLabel label="封面提示词" hint="可以在这里继续微调，满意后直接生成封面。" />
                  <textarea
                    value={coverForm.prompt}
                    onChange={(event) => onChange({ ...coverForm, prompt: event.target.value })}
                    rows={4}
                    className="w-full rounded-[20px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
                  />
                </label>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <label className="space-y-2">
                <InputLabel label="封面提示词" hint="描述想要的画面，例如：夜色中的舰桥，单人背影，电影感。" />
                <textarea
                  value={coverForm.prompt}
                  onChange={(event) => onChange({ ...coverForm, prompt: event.target.value })}
                  rows={4}
                  className="w-full rounded-[20px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
                  placeholder="想要什么样的封面，直接写在这里。"
                />
              </label>
              <label className="space-y-2">
                <InputLabel label="不想要的元素（可选）" />
                <textarea
                  value={coverForm.negativePrompt}
                  onChange={(event) => onChange({ ...coverForm, negativePrompt: event.target.value })}
                  rows={2}
                  className="w-full rounded-[20px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
                  placeholder="例如：杂乱、模糊、过曝"
                />
              </label>
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="flex flex-1 items-center gap-2">
              <span className="shrink-0 text-sm text-[var(--text-secondary)]">候选数量</span>
              <SelectControl
                value={coverForm.count}
                onChange={(event) => onChange({ ...coverForm, count: Number(event.target.value) })}
              >
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count} 张
                  </option>
                ))}
              </SelectControl>
            </label>
          </div>
          <p className="text-xs leading-5 text-[var(--text-tertiary)]">
            所有封面统一裁成书封比例 {FIXED_NOVEL_COVER_WIDTH} × {FIXED_NOVEL_COVER_HEIGHT}。
          </p>

          <div className="grid gap-2">
            <Button onClick={onGenerateImages} disabled={generatingImage} className="w-full justify-center">
              {generatingImage ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              生成封面
            </Button>
            <Button
              onClick={() => uploadInputRef.current?.click()}
              variant="ghost"
              className="w-full justify-center border border-[var(--border-subtle)]"
            >
              <Upload className="h-4 w-4" />
              本地上传封面
            </Button>
            {generatingImage ? (
              <div className="rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3">
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
                  <span>正在生成封面候选图</span>
                  <span>{Math.round(generationProgress)}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[rgba(15,23,42,0.08)]">
                  <div
                    className="h-full rounded-full bg-[var(--surface-contrast)] transition-[width] duration-[1067ms] ease-out"
                    style={{ width: `${generationProgress}%` }}
                  />
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
                  正在根据当前提示词生成封面，这一步通常会稍微久一点。
                </p>
              </div>
            ) : null}
          </div>

          {coverKeywords.length ? (
            <div className="flex flex-wrap gap-2">
              {coverKeywords.map((keyword) => (
                <Tag key={keyword}>{keyword}</Tag>
              ))}
            </div>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">封面候选</h4>
            <p className="text-xs leading-5 text-[var(--text-secondary)]">{coverMessage}</p>
          </div>

          {selectedCover ? (
            <div className="rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-4">
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setPreviewAsset(selectedCover)}
                  className="block w-full cursor-zoom-in"
                  aria-label="放大查看这张封面"
                >
                  <img
                    src={selectedCover.imageUrl}
                    alt="当前选中的封面候选"
                    className="aspect-[3/4] w-full rounded-[18px] border border-[var(--border-subtle)] object-cover transition hover:opacity-90"
                  />
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone="accent">当前预览</Tag>
                  {currentCoverId === selectedCover.id ? <Tag>当前封面</Tag> : null}
                </div>
                <p className="text-sm leading-7 text-[var(--text-secondary)]">
                  {selectedCover.prompt ?? '这一张候选封面还没有额外说明。'}
                </p>
                <div className="grid gap-2">
                  <Button
                    onClick={onApplyCover}
                    disabled={selectingCover || currentCoverId === selectedCover.id}
                    className="w-full justify-center"
                  >
                    {selectingCover ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {currentCoverId === selectedCover.id ? '已设为作品封面' : '设为作品封面'}
                  </Button>
                  <Button onClick={() => onSelectAsset(null)} variant="ghost" className="w-full justify-center">
                    取消选择
                  </Button>
                  <Button
                    onClick={() => onDownloadAsset(selectedCover)}
                    variant="secondary"
                    className="w-full justify-center"
                  >
                    <Download className="h-4 w-4" />
                    下载这张封面
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            {coverAssets.map((asset) => (
              <CoverAssetItem
                key={asset.id}
                asset={asset}
                selected={selectedCover?.id === asset.id}
                currentCoverId={currentCoverId}
                formatDateTime={formatDateTime}
                onSelect={() => onSelectAsset(asset.id)}
                onPreview={() => setPreviewAsset(asset)}
                onApply={() => onApplyAsset(asset)}
                onDownload={() => onDownloadAsset(asset)}
              />
            ))}
          </div>
        </div>
      </div>

      {previewAsset ? (
        <ImageLightbox
          src={previewAsset.imageUrl}
          alt="封面候选图"
          downloadName={`封面候选-${previewAsset.id}.jpg`}
          onClose={() => setPreviewAsset(null)}
        />
      ) : null}
    </ToolShell>
  )
}

function CoverAssetItem({
  asset,
  selected,
  currentCoverId,
  formatDateTime,
  onSelect,
  onPreview,
  onApply,
  onDownload,
}: {
  asset: CoverAsset
  selected: boolean
  currentCoverId?: string | null
  formatDateTime: (value?: string | null) => string
  onSelect: () => void
  onPreview: () => void
  onApply: () => void
  onDownload: () => void
}) {
  return (
    <div
      className={
        selected
          ? 'rounded-[18px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-3 transition-colors'
          : 'rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-3 transition-colors hover:border-[var(--border-strong)]'
      }
    >
      <div className="flex w-full items-center gap-3">
        <button
          type="button"
          onClick={onPreview}
          className="shrink-0 cursor-zoom-in"
          aria-label="放大查看这张封面"
        >
          <img
            src={asset.imageUrl}
            alt="封面候选图"
            className="aspect-[3/4] w-20 rounded-[14px] object-cover transition hover:opacity-90"
          />
        </button>
        <button type="button" onClick={onSelect} className="min-w-0 flex-1 space-y-2 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">封面候选</p>
            {currentCoverId === asset.id ? <Tag tone="accent">当前封面</Tag> : null}
            {selected ? <Tag>当前预览</Tag> : null}
          </div>
          <p className="line-clamp-3 break-words text-sm leading-6 text-[var(--text-secondary)]">
            {asset.prompt ?? '点击查看这张封面的完整预览。'}
          </p>
          <span className="block text-xs text-[var(--text-tertiary)]">{formatDateTime(asset.createdAt)}</span>
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          onClick={onApply}
          disabled={currentCoverId === asset.id}
          className="h-9 justify-center px-4"
          size="sm"
        >
          <Check className="h-4 w-4" />
          {currentCoverId === asset.id ? '已在使用' : '一键更换'}
        </Button>
        <Button onClick={onDownload} variant="secondary" className="h-9 justify-center px-4" size="sm">
          <Download className="h-4 w-4" />
          下载
        </Button>
      </div>
    </div>
  )
}
