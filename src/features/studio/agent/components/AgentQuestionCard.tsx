import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, CornerDownLeft, Info, LoaderCircle, ZoomIn } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatAgentQuestionOption, type AgentQuestionDecision, type AgentQuestionPrompt } from '../../../../../shared/contracts/agent-events.js'
import ImageLightbox from '../../components/ImageLightbox'
import type { PendingQuestion } from '../agentStore'

type AgentQuestionCardProps = {
  question: PendingQuestion
  onAnswer: (decision: AgentQuestionDecision) => Promise<boolean>
  coverImages?: ReadonlyMap<string, string>
}

type Choice = number | 'custom'
type QuestionChoice = { value: Choice; label: string; detail?: string; image?: string }
type Draft = { choice: Choice | null; customAnswer: string }
type OpenDetail = { option: number; anchor: HTMLButtonElement }
const emptyDraft: Draft = { choice: null, customAnswer: '' }
const submissionFailed = '提交失败，请稍后再试。'
const focusRing = 'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--text-secondary)]'

function readAnswer(prompt: AgentQuestionPrompt, draft: Draft) {
  if (draft.choice === 'custom' || !prompt.options.length) return draft.customAnswer.trim()
  const selected = typeof draft.choice === 'number' ? prompt.options[draft.choice] : undefined
  if (!selected) return ''
  return formatAgentQuestionOption(selected)
}

function OptionTooltip({ id, anchor, detail, onClose }: { id: string; anchor: HTMLButtonElement; detail: string; onClose: () => void }) {
  const tooltip = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean }>()
  useLayoutEffect(() => {
    const viewport = window.visualViewport
    const options = anchor.closest('[data-agent-question-options]')
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const bounds = options?.getBoundingClientRect()
      if (bounds?.height && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) {
        onClose()
        return
      }
      const leftEdge = viewport?.offsetLeft ?? 0
      const topEdge = viewport?.offsetTop ?? 0
      const viewportWidth = viewport?.width ?? window.innerWidth
      const viewportHeight = viewport?.height ?? window.innerHeight
      const width = Math.min(268, viewportWidth - 16)
      const aboveSpace = rect.top - topEdge - 14
      const belowSpace = topEdge + viewportHeight - rect.bottom - 14
      const above = belowSpace < 112 && aboveSpace > belowSpace
      setPosition({
        left: Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + viewportWidth - width - 8)),
        top: above ? rect.top - 6 : rect.bottom + 6,
        width, maxHeight: Math.max(0, Math.min(168, above ? aboveSpace : belowSpace)), above,
      })
    }
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !anchor.contains(event.target) && !tooltip.current?.contains(event.target)) onClose()
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
    }
  }, [anchor, onClose])
  if (!position) return null
  return createPortal(
    <div ref={tooltip} id={id} role="tooltip" tabIndex={-1}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key !== 'Escape') return
        event.preventDefault()
        onClose()
        anchor.focus({ preventScroll: true })
      }}
      className="studio-workspace fixed z-[160] overflow-y-auto overscroll-contain break-words rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-xs leading-5 text-[var(--text-primary)] shadow-[0_8px_22px_rgba(0,0,0,0.18)]"
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.above ? 'translateY(-100%)' : undefined }}>
      {detail}
    </div>,
    document.fullscreenElement ?? document.body,
  )
}

export function AgentQuestionCard(props: AgentQuestionCardProps) {
  return <QuestionForm key={JSON.stringify([props.question.requestId, props.question.callId])} {...props} />
}

function QuestionForm({ question, onAnswer, coverImages }: AgentQuestionCardProps) {
  const id = useId()
  const batch = question.questions?.length ? question.questions : undefined
  const prompts = batch ?? [question]
  const [step, setStep] = useState(0)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [openDetail, setOpenDetail] = useState<OpenDetail | null>(null)
  const [coverPreview, setCoverPreview] = useState<{ image: string; label: string } | null>(null)
  const closeDetail = useCallback(() => setOpenDetail(null), [])
  const [phase, setPhase] = useState<'ready' | 'sending' | 'sent' | 'cancelling' | 'cancelled'>('ready')
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const customAnswerInput = useRef<HTMLInputElement>(null)
  const previousStep = useRef(step)
  const inFlight = useRef(false)
  const prompt = prompts[step]
  const draft = drafts[step] ?? emptyDraft
  const answer = readAnswer(prompt, draft)
  const last = step === prompts.length - 1
  const locked = phase !== 'ready'
  const submitting = phase === 'sending' || phase === 'cancelling'
  const activeDetail = openDetail ? prompt.options[openDetail.option]?.detail : undefined
  const choices: QuestionChoice[] = prompt.options.map((option, index) => ({
    ...option, value: index, image: option.coverAssetId ? coverImages?.get(option.coverAssetId) : undefined,
  }))
  if (choices.length) choices.push({ value: 'custom', label: '自定义回答' })
  const choiceRows: QuestionChoice[][] = []
  for (const choice of choices) {
    const previousRow = choiceRows.at(-1)
    if (choice.image && previousRow?.[0].image) previousRow.push(choice)
    else choiceRows.push([choice])
  }

  useLayoutEffect(() => {
    if (previousStep.current === step) return
    previousStep.current = step
    if (body.current) body.current.scrollTop = 0
    heading.current?.focus({ preventScroll: true })
  }, [step])

  function updateDraft(update: Partial<Draft>) {
    setDrafts(previous => ({ ...previous, [step]: { ...(previous[step] ?? emptyDraft), ...update } }))
    setError(null)
  }

  function moveTo(index: number) {
    if (inFlight.current || index < 0 || index >= prompts.length) return
    setStep(index)
    setOpenDetail(null)
    setError(null)
  }

  function focusCustomAnswer(event: MouseEvent<HTMLLabelElement>) {
    // Pointer activation enters the field; native radio keyboard movement still
    // leaves focus on the option so arrows and Tab behave normally.
    if (!event.detail || locked) return
    event.preventDefault()
    updateDraft({ choice: 'custom' })
    customAnswerInput.current?.focus({ preventScroll: true })
  }

  async function submit(decision: AgentQuestionDecision) {
    if (inFlight.current) return
    const cancelled = 'cancelled' in decision
    inFlight.current = true
    setOpenDetail(null)
    setError(null)
    setPhase(cancelled ? 'cancelling' : 'sending')
    try {
      if (!await onAnswer(decision)) throw new Error(submissionFailed)
      setPhase(cancelled ? 'cancelled' : 'sent')
    } catch (failure) {
      inFlight.current = false
      setError(failure instanceof Error ? failure.message : submissionFailed)
      setPhase('ready')
    }
  }

  function advance() {
    if (!answer || inFlight.current) return
    if (!last) {
      moveTo(step + 1)
      return
    }
    if (!batch) {
      void submit({ answer })
      return
    }
    const answers = prompts.map((item, index) => readAnswer(item, drafts[index] ?? emptyDraft))
    if (answers.every(Boolean)) void submit({ answers })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (coverPreview || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (openDetail?.anchor === event.target) {
        setOpenDetail(null)
        return
      }
      void submit({ cancelled: true })
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      advance()
    }
  }

  const customInput = <input ref={customAnswerInput} aria-label="自定义回答" value={draft.customAnswer} disabled={locked} maxLength={500} autoComplete="off"
    enterKeyHint={last ? 'send' : 'next'} placeholder="输入自定义回答（如果你有其它想法...）"
    onFocus={() => { if (draft.choice !== 'custom') updateDraft({ choice: 'custom' }) }}
    onChange={event => updateDraft({ choice: 'custom', customAnswer: event.target.value })}
    className="relative z-10 min-h-11 w-full min-w-0 border-0 bg-transparent px-2 text-base text-[var(--text-primary)] [outline:none] placeholder:text-[var(--text-secondary)] focus:[outline:none] focus:[box-shadow:none] sm:text-sm" />

  function renderChoice(option: QuestionChoice) {
    const { value, label, image } = option
    const active = draft.choice === value
    const custom = value === 'custom'
    const recommended = value === 0
    const expanded = openDetail?.option === value
    const optionId = `${id}-${step}-option-${value}`
    const detailId = `${optionId}-detail`
    const recommendationId = `${optionId}-recommended`
    const radio = <input type="radio" name={`${id}-choice-${step}`} checked={active} className="sr-only" aria-labelledby={optionId}
      aria-describedby={recommended ? recommendationId : undefined} onChange={() => updateDraft({ choice: value })} />
    const recommendation = recommended
      ? <span id={recommendationId} className="shrink-0 text-[11px] font-normal text-[var(--text-secondary)]">推荐</span>
      : null
    const detail = option.detail && typeof value === 'number' ? (
      <button type="button" disabled={locked} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}
        aria-describedby={expanded ? detailId : undefined} aria-label={`${expanded ? '收起' : '查看'}「${label}」说明`}
        onClick={event => setOpenDetail(expanded ? null : { option: value, anchor: event.currentTarget })}
        className={cn('relative z-10 inline-flex w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] sm:w-7',
          image ? 'h-7' : 'h-11 sm:h-9', expanded && 'text-[var(--text-primary)]', focusRing)}>
        <Info aria-hidden className="h-3.5 w-3.5" />
      </button>
    ) : null

    if (image) return (
      <div key={value} className={cn('relative min-w-0 rounded-lg',
        active ? 'bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)]' : !locked && 'hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]')}>
        <div className="p-1.5">
          <label className={cn("block min-w-0 rounded-md after:absolute after:inset-0 after:content-['']",
            'has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--text-secondary)]',
            !locked && 'cursor-pointer')}>
            {radio}
            <span className="relative block aspect-[3/4] overflow-hidden rounded-md bg-[var(--surface-default)]">
              <img src={image} alt="" draggable={false} className="h-full w-full object-contain" />
              {active ? <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[#2c6b52] text-white">
                <Check aria-hidden className="h-3.5 w-3.5" />
              </span> : null}
            </span>
            <span id={optionId} className="mt-1.5 block break-words text-xs font-medium leading-4 text-[var(--text-primary)]">{label}</span>
          </label>
          {recommendation || detail ? <div className="flex items-center justify-between gap-1">
            {recommendation ?? <span />}
            {detail}
          </div> : null}
        </div>
        <button type="button" disabled={locked} aria-label={`放大查看封面「${label}」`} title="放大查看"
          onClick={event => {
            event.currentTarget.focus({ preventScroll: true })
            closeDetail()
            setCoverPreview({ image, label })
          }}
          className={cn('absolute right-1 top-1 z-10 grid h-8 w-8 place-items-center rounded-md bg-slate-950/70 text-white hover:bg-slate-950/90', focusRing)}>
          <ZoomIn aria-hidden className="h-4 w-4" />
        </button>
      </div>
    )

    return (
      <div key={value} className={cn(
        'relative flex min-h-11 min-w-0 items-center gap-1 rounded-lg px-2',
        'has-[[type=radio]:focus-visible]:outline has-[[type=radio]:focus-visible]:outline-1 has-[[type=radio]:focus-visible]:-outline-offset-1 has-[[type=radio]:focus-visible]:outline-[var(--text-secondary)]',
        custom && 'focus-within:bg-[color-mix(in_srgb,var(--text-primary)_12%,transparent)]',
        active ? 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]'
          : custom ? 'bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]' : !locked && 'hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]',
      )}>
        <label onClick={value === 'custom' ? focusCustomAnswer : undefined} className={cn(
          "flex min-h-11 min-w-0 items-center gap-2.5 text-sm font-medium leading-5 text-[var(--text-primary)] after:absolute after:inset-0 after:content-['']",
          custom && 'shrink-0', !locked && 'cursor-pointer',
        )}>
          {radio}
          <span aria-hidden className={cn('w-4 shrink-0 text-xs font-normal tabular-nums',
            active ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]')}>
            {(typeof value === 'number' ? value + 1 : prompt.options.length + 1)}.
          </span>
          <span id={optionId} className={custom ? 'sr-only' : 'min-w-0 break-words py-2'}>{label}</span>
          {recommendation}
        </label>
        {custom ? customInput : null}
        {detail}
      </div>
    )
  }

  return (
    <form aria-labelledby={`${id}-title`} aria-busy={submitting} data-agent-question onKeyDown={handleKeyDown}
      onSubmit={event => event.preventDefault()}
      className="mb-3 mx-auto w-full max-w-[620px] min-w-0 overflow-hidden rounded-[18px] border border-[var(--border-strong)] bg-[var(--surface-elevated,var(--surface-default))] shadow-[0_8px_26px_rgba(0,0,0,0.12)]">
      <header className="flex items-start justify-between gap-3 px-4 py-3">
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1}
          className="min-w-0 break-words text-base font-semibold leading-6 text-[var(--text-primary)] outline-none">
          {prompt.question}
        </h3>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" disabled={locked || step === 0} aria-label="上一题" onClick={() => moveTo(step - 1)}
            className={cn('inline-grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-35', focusRing)}>
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </button>
          <span aria-live="polite" aria-label={`第 ${step + 1} 题，共 ${prompts.length} 题`}
            className="text-xs font-medium leading-6 tabular-nums text-[var(--text-secondary)]">
            {step + 1} / {prompts.length}
          </span>
          <button type="button" disabled={locked || last || !answer} aria-label="下一题" onClick={() => moveTo(step + 1)}
            className={cn('inline-grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-35', focusRing)}>
            <ChevronRight aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div ref={body} data-agent-question-options className={cn('overflow-y-auto overscroll-contain px-2',
        choiceRows.some(row => row[0].image) ? 'max-h-[min(252px,42dvh)]' : 'max-h-[min(180px,39dvh)]')}>
        {choices.length ? (
          <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">选择回答</legend>
            {choiceRows.map(row => row[0].image ? (
              <div key={row[0].value} data-agent-question-covers className="mb-1 grid justify-center gap-1.5 px-1 sm:gap-3"
                style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, min(26vw, 6.875rem)))` }}>
                {row.map(renderChoice)}
              </div>
            ) : renderChoice(row[0]))}
          </fieldset>
        ) : <div className="rounded-lg bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] px-2 focus-within:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]">{customInput}</div>}
      </div>

      <footer className="px-3 py-1.5">
        {error ? <p role="alert" className="px-1 pb-1.5 break-words text-xs leading-5 text-[var(--color-error)]">{error}</p> : null}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
          <button type="button" disabled={locked || step === 0} onClick={() => moveTo(step - 1)} aria-label="返回" title="返回"
            className={cn('inline-grid h-9 w-9 place-items-center justify-self-start rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-35', focusRing)}>
            <ArrowLeft aria-hidden className="h-[18px] w-[18px]" />
          </button>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <button type="button" disabled={locked} onClick={() => void submit({ cancelled: true })}
              className={cn('inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50', focusRing)}>
              {phase === 'cancelling' ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
              <span aria-live="polite">{phase === 'cancelling' ? '取消中…' : phase === 'cancelled' ? '已取消' : '取消'}</span>
              {phase === 'ready' ? <kbd aria-hidden className="inline-grid h-5 min-w-7 translate-y-px place-items-center rounded-[5px] bg-[var(--surface-muted)] px-1 text-[10px] leading-none text-[var(--text-secondary)]">Esc</kbd> : null}
            </button>
            <button type="button" disabled={locked || !answer} onClick={advance}
              className={cn('inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#2c6b52] px-3.5 text-sm font-medium text-white hover:bg-[#347a5e] disabled:bg-[#254435] disabled:text-[#a3b5aa]', focusRing)}>
              {phase === 'sending' ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
              <span aria-live="polite">{phase === 'sending' ? '提交中…' : phase === 'sent' ? '已提交' : last ? '提交回答' : '继续'}</span>
              <CornerDownLeft aria-hidden className="h-4 w-4 shrink-0" />
            </button>
          </div>
        </div>
      </footer>
      {openDetail && activeDetail ? <OptionTooltip id={`${id}-${step}-option-${openDetail.option}-detail`} anchor={openDetail.anchor}
        detail={activeDetail} onClose={closeDetail} /> : null}
      {coverPreview ? <ImageLightbox src={coverPreview.image} alt={coverPreview.label} trapFocus onClose={() => setCoverPreview(null)} /> : null}
    </form>
  )
}
