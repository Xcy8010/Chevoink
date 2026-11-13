import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Download, ImagePlus, LoaderCircle, PenLine, Sparkles, Upload, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'

import { requestJson } from '@/app/api-client'
import { nextModelPriceRefreshAt, useModelPriceRefresh } from '@/app/live-configuration'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { GetAiConfigResponse } from '../../../../shared/contracts/api'
import { FIXED_NOVEL_COVER_HEIGHT, FIXED_NOVEL_COVER_WIDTH, type CoverAsset } from '../../../../shared/contracts/index.js'
import { formatModelPrice } from '../../../../shared/model-price-format'

import type { CoverFormState } from '../types'
import ImageLightbox from './ImageLightbox'
import { SelectControl } from './StudioControls'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

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
  modal?: boolean
}

const textareaClass = 'w-full min-w-0 resize-y rounded-xl border border-[var(--border-subtle)] bg-transparent px-3 py-2.5 text-sm leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]'
const controlClass = 'min-h-11 rounded-xl'
const disclosureClass = 'flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-primary)]'
const imageConfigKey = ['ai', 'public-config'] as const

export default function CoverPanel({
  coverForm, coverAssets, selectedCover, currentCoverId, coverKeywords, coverMessage,
  generatingPrompt, generatingImage, generationProgress, selectingCover, formatDateTime,
  onChange, onUploadFile, onGeneratePrompt, onGenerateImages, onSelectAsset, onApplyCover, onApplyAsset, onDownloadAsset,
  onClose, modal = false,
}: CoverPanelProps) {
  const client = useQueryClient()
  const imageConfig = useQuery({
    queryKey: imageConfigKey,
    queryFn: ({ signal }) => requestJson<GetAiConfigResponse['data']>('/api/ai/config', { signal }),
    staleTime: 20000,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  })
  const imageModel = imageConfig.data?.imageModel
  useModelPriceRefresh(client, imageConfigKey, imageModel ? nextModelPriceRefreshAt([imageModel], imageConfig.dataUpdatedAt) : undefined)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const [promptMode, setPromptMode] = useState<'smart' | 'manual'>('smart')
  const [previewAsset, setPreviewAsset] = useState<CoverAsset | null>(null)
  useDialogFocusTrap({ panel: panelRef, open: modal, onClose })

  const progress = Math.round(generationProgress)
  const currentSelected = Boolean(selectedCover && currentCoverId === selectedCover.id)
  const panel = (
    <section
      ref={panelRef}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      aria-labelledby={modal ? titleId : undefined}
      tabIndex={modal ? -1 : undefined}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden text-[var(--text-primary)] outline-none',
        modal
          ? 'h-[min(48rem,calc(100dvh-3rem))] w-full max-w-[60rem] rounded-2xl border border-[var(--border-subtle)] bg-[var(--app-bg)] shadow-[var(--shadow-modal)] lg:bg-[var(--surface-default)]'
          : 'flex-1 bg-[var(--app-bg)]',
      )}
    >
      {modal ? (
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-6 py-2.5">
          <h2 id={titleId} className="text-lg font-semibold">封面工坊</h2>
          <Button variant="ghost" aria-label="关闭封面工坊" onClick={onClose} className={cn(controlClass, 'w-11 p-0')}>
            <X aria-hidden="true" className="h-5 w-5" />
          </Button>
        </header>
      ) : null}

      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="选择封面图片"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onUploadFile(file)
          event.target.value = ''
        }}
      />

      <div className={cn(
        'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain',
          modal && 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden',
      )}>
        <section aria-label="生成设置" className={cn('min-w-0 space-y-4 p-4', modal && 'lg:overflow-y-auto lg:overscroll-contain lg:p-6')}>
          <div aria-label="提示词方式" role="group" className="grid grid-cols-2 gap-1 rounded-xl border border-[var(--border-subtle)] p-1">
            {([
              ['smart', '智能生成', Sparkles],
              ['manual', '手动输入', PenLine],
            ] as const).map(([mode, label, Icon]) => (
              <Button
                key={mode}
                onClick={() => setPromptMode(mode)}
                variant="ghost"
                aria-pressed={promptMode === mode}
                className={cn(controlClass, 'min-w-0 px-2', promptMode === mode && 'bg-[var(--surface-muted)] text-[var(--text-primary)]')}
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                {label}
              </Button>
            ))}
          </div>

          {promptMode === 'smart' ? (
            <Button variant="secondary" onClick={onGeneratePrompt} disabled={generatingPrompt} className={controlClass}>
              {generatingPrompt ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : <Sparkles aria-hidden="true" className="h-4 w-4" />}
              {generatingPrompt ? '正在生成提示词' : '智能生成提示词'}
            </Button>
          ) : null}

          <label className="block space-y-2">
            <span className="text-sm font-medium">封面提示词</span>
            <textarea
              value={coverForm.prompt}
              onChange={(event) => onChange({ ...coverForm, prompt: event.target.value })}
              rows={4}
              className={textareaClass}
              placeholder={promptMode === 'smart' ? '可根据作品信息生成提示词，也可直接输入。' : '例如：夜色中的舰桥，单人背影，电影感'}
            />
          </label>
          {coverKeywords.length ? (
            <ul aria-label="封面关键词" className="flex flex-wrap gap-1.5 text-xs text-[var(--text-secondary)]">
              {coverKeywords.map((keyword) => <li key={keyword} className="rounded-md bg-[var(--surface-muted)] px-2 py-1">{keyword}</li>)}
            </ul>
          ) : null}

          {promptMode === 'manual' ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium">不想要的元素 <span className="font-normal text-[var(--text-secondary)]">（可选）</span></span>
              <textarea
                value={coverForm.negativePrompt}
                onChange={(event) => onChange({ ...coverForm, negativePrompt: event.target.value })}
                rows={2}
                className={textareaClass}
                placeholder="例如：杂乱、模糊、过曝"
              />
            </label>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-3">
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              候选数量
              <SelectControl
                value={coverForm.count}
                className="rounded-xl border-[var(--border-subtle)] bg-transparent"
                onChange={(event) => onChange({ ...coverForm, count: Number(event.target.value) })}
              >
                {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} 张</option>)}
              </SelectControl>
            </label>
            <span className="text-xs text-[var(--text-secondary)]">{FIXED_NOVEL_COVER_WIDTH} × {FIXED_NOVEL_COVER_HEIGHT} px</span>
          </div>
          {imageConfig.data?.imageModel && <CoverPrice price={imageConfig.data.imageModel} />}
          {imageConfig.isError && <p className="text-sm text-[var(--text-secondary)]">图片价格暂不可用。</p>}
        </section>

        <section aria-label="封面候选" className={cn(
          'min-w-0 space-y-3 border-t border-[var(--border-subtle)] p-4',
          modal && 'lg:overflow-y-auto lg:overscroll-contain lg:border-l lg:border-t-0 lg:p-6',
        )}>
          <h3 className="text-sm font-semibold">封面候选</h3>
          {selectedCover ? (
            <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-3">
              <button
                type="button"
                onClick={() => setPreviewAsset(selectedCover)}
                className="mx-auto block cursor-zoom-in rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                aria-label="放大预览选中的封面"
              >
                <img src={selectedCover.imageUrl} alt="选中的封面候选" className="aspect-[3/4] w-32 max-w-full rounded-lg object-cover" />
              </button>
              {selectedCover.prompt ? (
                <details className="group break-words">
                  <summary className={disclosureClass}>
                    <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 -rotate-90 group-open:rotate-0" />查看这张封面的提示词
                  </summary>
                  <p className="whitespace-pre-wrap px-1 text-sm leading-6 text-[var(--text-secondary)]">{selectedCover.prompt}</p>
                </details>
              ) : null}
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                <Button onClick={onApplyCover} disabled={selectingCover || currentSelected} className={controlClass}>
                  {selectingCover ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : <Check aria-hidden="true" className="h-4 w-4" />}
                  {currentSelected ? '已设为作品封面' : '设为作品封面'}
                </Button>
                <Button onClick={() => onDownloadAsset(selectedCover)} variant="ghost" className={controlClass}>
                  <Download aria-hidden="true" className="h-4 w-4" />下载这张封面
                </Button>
                <Button onClick={() => onSelectAsset(null)} variant="ghost" className={controlClass}>取消选择</Button>
              </div>
            </div>
          ) : null}

          {coverAssets.length ? (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {coverAssets.map((asset) => (
                <CoverAssetItem
                  key={asset.id}
                  asset={asset}
                  selected={selectedCover?.id === asset.id}
                  currentCoverId={currentCoverId}
                  selectingCover={selectingCover}
                  formatDateTime={formatDateTime}
                  onSelect={() => onSelectAsset(asset.id)}
                  onPreview={() => setPreviewAsset(asset)}
                  onApply={() => onApplyAsset(asset)}
                  onDownload={() => onDownloadAsset(asset)}
                />
              ))}
            </ul>
          ) : (
            <p className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-[var(--border-subtle)] px-4 text-sm text-[var(--text-secondary)]">暂无封面候选</p>
          )}
        </section>
      </div>

      <footer className="shrink-0 space-y-2 border-t border-[var(--border-subtle)] px-4 py-3 lg:px-6">
        {coverMessage ? <p role="status" className="break-words text-sm text-[var(--text-secondary)]">{coverMessage}</p> : null}
        {generatingImage ? (
          <div className="flex items-center gap-2.5 text-xs text-[var(--text-secondary)]">
            <span>正在生成封面候选图</span>
            <progress aria-label="生成封面进度" value={progress} max={100} className="h-1.5 min-w-0 flex-1 accent-[var(--surface-contrast)]" />
            <span className="tabular-nums">{progress}%</span>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => uploadInputRef.current?.click()} variant="secondary" className={controlClass}>
            <Upload aria-hidden="true" className="h-4 w-4" />本地上传封面
          </Button>
          <Button onClick={onGenerateImages} variant="primary" disabled={generatingImage} className={controlClass}>
            {generatingImage ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : <ImagePlus aria-hidden="true" className="h-4 w-4" />}
            生成封面
          </Button>
        </div>
      </footer>

      {previewAsset ? (
        <ImageLightbox
          src={previewAsset.imageUrl}
          alt="封面候选图"
          downloadName={'封面候选-' + previewAsset.id + '.jpg'}
          trapFocus
          onClose={() => setPreviewAsset(null)}
        />
      ) : null}
    </section>
  )

  return modal ? (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/35 p-3 lg:p-6" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {panel}
    </div>
  ) : panel
}

function CoverPrice({ price }: { price: NonNullable<GetAiConfigResponse['data']['imageModel']> }) {
  const base = formatModelPrice(price.basePerCallCredits) + ' Credits / 批'
  const discounted = Boolean(price.activity?.name && price.basePerCallCredits > price.perCallCredits)
  return (
    <details className="group border-t border-[var(--border-subtle)] text-sm text-[var(--text-secondary)]">
      <summary className={cn(disclosureClass, 'py-2.5')}>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 -rotate-90 group-open:rotate-0" />
        <span className="min-w-0 break-words">
          {price.label}{price.activity?.name ? ' · ' + price.activity.name : ''} · {discounted ? <><s>{base}</s> → </> : null}
          当前 {formatModelPrice(price.perCallCredits)} Credits / 批
        </span>
      </summary>
      <div className="space-y-1.5 pb-2 text-xs leading-5">
        <p>{price.publicDescription}</p>
        {price.publicFeatures.map((feature, index) => <p key={index}>{feature}</p>)}
        <p>基础 {discounted ? <s>{base}</s> : base} · 当前 {formatModelPrice(price.multiplier)}x{price.discountRatio !== null ? ' · 当前 / 基础 ' + formatModelPrice(price.discountRatio) : ''}</p>
        {price.activity ? (
          <>
            <p>活动时区 {price.activity.timezone} · 当前 {price.activity.name ?? '无活动'}</p>
            {price.activity.rules.map((rule, index) => (
              <p key={index}>
                {rule.name} · {rule.enabled ? '启用' : '停用'} · {rule.startDate ?? '不限开始'} 至 {rule.endDate ? rule.endDate + '（不含）' : '不限结束'} · 周{rule.weekdays.map(day => ['日', '一', '二', '三', '四', '五', '六'][day]).join('、')} · {rule.allDay ? '全天' : rule.startTime + '–' + rule.endTime + (rule.endTime < rule.startTime ? '（跨夜）' : '')} · {formatModelPrice(rule.multiplierBps / 10000)}x
              </p>
            ))}
            {price.activity.nextSwitchAt ? <p>下次切换 {new Intl.DateTimeFormat('zh-CN', { timeZone: price.activity.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(price.activity.nextSwitchAt))}（{price.activity.timezone}）</p> : null}
          </>
        ) : null}
      </div>
    </details>
  )
}

function CoverAssetItem({
  asset, selected, currentCoverId, selectingCover, formatDateTime, onSelect, onPreview, onApply, onDownload,
}: {
  asset: CoverAsset
  selected: boolean
  currentCoverId?: string | null
  selectingCover: boolean
  formatDateTime: (value?: string | null) => string
  onSelect: () => void
  onPreview: () => void
  onApply: () => void
  onDownload: () => void
}) {
  const inUse = currentCoverId === asset.id
  return (
    <li className="flex min-w-0 items-start gap-3 py-3">
      <button type="button" onClick={onPreview} className="shrink-0 cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label="放大查看这张封面">
        <img src={asset.imageUrl} alt="封面候选图" className="aspect-[3/4] w-14 rounded-md object-cover" />
      </button>
      <div className="min-w-0 flex-1">
        <button type="button" aria-pressed={selected} onClick={onSelect} className="block min-h-11 w-full rounded-md text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          <span className="block font-medium">{inUse ? '作品封面' : '封面候选'}{selected ? ' · 已选中' : ''}</span>
          {asset.prompt ? <span className="line-clamp-1 break-words text-[var(--text-secondary)]">{asset.prompt}</span> : null}
          <span className="block text-xs text-[var(--text-secondary)]">{formatDateTime(asset.createdAt)}</span>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button onClick={onApply} variant="ghost" disabled={selectingCover || inUse} className={cn(controlClass, 'px-2')}>
            {inUse ? '已在使用' : '一键更换'}
          </Button>
          <Button onClick={onDownload} variant="ghost" className={cn(controlClass, 'px-2')} aria-label="下载这张候选封面">
            <Download aria-hidden="true" className="h-4 w-4" />下载
          </Button>
        </div>
      </div>
    </li>
  )
}
