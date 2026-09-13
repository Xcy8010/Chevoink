import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { ArrowUp, BookOpenText, Check, ChevronDown, ChevronRight, Feather, FileText, Image, LoaderCircle, Mic, Pencil, Play, Plus, Rocket, Scale, Settings2, Square, Wrench, X } from 'lucide-react'
import { ReasoningSlider } from './ReasoningSlider'
import StyleLearningDialog from '../../components/StyleLearningDialog'
import { SubagentPicker } from './SubagentPicker'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast-context'
import { AgentMobileModelSheet } from './AgentMobileModelSheet'

import {
  AGENT_FILE_ACCEPT,
  MAX_AGENT_FILE_COUNT,
  MAX_AGENT_IMAGE_COUNT,
  type AgentAttachmentMeta,
} from '../../../../../shared/contracts/agent-attachments.js'
import type {
  AgentSkillListItem,
  CreditModelOption,
  CreditModelTier,
  CustomModelView,
  CreativeFreedom,
  ModelReasoningEffort,
  StoryCompilerMode,
} from '../../../../../shared/contracts/index.js'
import { prepareAgentImage, readFileAsDataUrl, validateAgentFile } from '../agent-attachments'
import { uploadAgentAttachment } from '../agentApi'
import { getChapterContent } from '../../api'
import { useAgentStore, type ComposerReference } from '../agentStore'
import { activateComposerDraft, updateComposerDraft } from '../composer-drafts'
import { useVoiceInput } from '../hooks/useVoiceInput'
import { AgentVoiceInputBar } from './AgentVoiceInputBar'
import { insertVoiceTranscript } from '../voice-insertion'
import {
  buildComposerPrompt,
  COMPOSER_REFERENCE_MIME,
  formatReferenceLineLabel,
  parseComposerReferenceTransfer,
  referenceKindLabel,
} from '../composer-content'

/**
 * Agent 输入区：
 * - Agent 默认最大权限（无模式切换），Enter 发送、Shift+Enter 换行；运行中主按钮切换为停止
 * - 图片（≤6 张）/文件（≤3 个）附件按钮：选件即传，预览可删，随提示词发送
 */

function formatAttachmentSize(size?: number): string {
  if (!size || size <= 0) {
    return ''
  }
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))}KB`
  }
  return `${(size / (1024 * 1024)).toFixed(1)}MB`
}

type AgentComposerProps = {
  novelId: string
  voiceScopeKey?: string
  voiceDisabled?: boolean
  running: boolean
  stopping?: boolean
  disabled?: boolean
  /** 可返回 Promise：启动失败时抛错，输入框保留草稿与附件 */
  onSend: (prompt: string, attachments: AgentAttachmentMeta[], creativeFreedom: CreativeFreedom, qualityMode: StoryCompilerMode, pinnedSkillIds: string[], pinnedSubagentId?: string) => Promise<void> | void
  onStop: () => void
  onContinue?: () => Promise<void>
  creativeFreedom: CreativeFreedom
  onCreativeFreedomChange: (value: CreativeFreedom) => void
  qualityMode: StoryCompilerMode
  modelTier: CreditModelTier
  modelOptions: CreditModelOption[]
  onModelTierChange: (value: CreditModelTier) => void
  customModels: CustomModelView[]
  customModelId: string | null
  onCustomModelChange: (modelId: string) => void
  reasoningSelections: Record<string, ModelReasoningEffort>
  onReasoningEffortChange: (modelKey: string, effort: ModelReasoningEffort) => void
  onOpenModelSettings: () => void
  referenceOptions: Array<Omit<ComposerReference, 'offset'>>
  /** 当前作品已启用的技能：供作者在“+”菜单里手动指定本轮要用哪个。 */
  skills?: AgentSkillListItem[]
  /** 打开技能区：作者在菜单里发现要新建/导入/启用技能时直达。 */
  onOpenSkillManager?: () => void
}

type ParsedComposerContent = {
  draft: string
  references: ComposerReference[]
}

const CREATIVE_MODES: Array<{ value: CreativeFreedom; label: string; description: string; icon: typeof Feather }> = [
  { value: 'stable', label: '平衡延续', description: '贴合既有走向，适合续写与轻量调整。', icon: Scale },
  { value: 'balanced', label: '严谨创作', description: '默认；强化因果与人类感，并自动落实检查建议。', icon: Feather },
  { value: 'bold', label: '大胆创作', description: '适合试新场景和新结构，报告只提示不自动改写。', icon: Rocket },
]

const REASONING_ORDER: ModelReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const REASONING_LABELS: Record<ModelReasoningEffort, string> = { none: '关闭', minimal: '轻度', low: '低', medium: '中', high: '高', xhigh: '极高', max: 'Max' }

/** 与技能区保持一致的阶段中文名 */
const SKILL_PHASE_LABELS: Record<string, string> = {
  research: '调研', plan: '规划', scene: '场景', draft: '正文', critique: '审阅', revision: '修订', commit: '落库',
}
/** 手动指定上限：与后端 startAgentLoopRunSchema 一致 */
const MAX_PINNED_SKILLS = 3

function skillSourceLabel(source: AgentSkillListItem['source']): string | null {
  if (source === 'user') return '自建'
  if (source === 'agent') return 'Agent'
  if (source === 'third_party') return '导入'
  return null
}

function skillHintLine(skill: AgentSkillListItem): string {
  const phases = skill.phases.map((phase) => SKILL_PHASE_LABELS[phase] ?? phase).join('/')
  const triggers = skill.triggerLabels.slice(0, 2).join('、')
  return [phases, triggers ? `适用：${triggers}` : skill.description].filter(Boolean).join(' · ')
}

function orderedReasoningEfforts(efforts: ModelReasoningEffort[]) {
  return [...new Set(efforts)].sort((left, right) => REASONING_ORDER.indexOf(left) - REASONING_ORDER.indexOf(right))
}

function referenceLineLabel(reference: ComposerReference): string {
  return formatReferenceLineLabel(reference)
}

function composerSignature(draft: string, references: ComposerReference[]): string {
  return JSON.stringify({
    draft,
    references: references.map(({ id, offset }) => ({ id, offset })),
  })
}

function isComposerBlank(text: string): boolean {
  return !text.replace(/[\u200B\uFEFF]/g, '').trim()
}

function createReferenceNode(reference: ComposerReference): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.dataset.composerReference = reference.id
  chip.contentEditable = 'false'
  chip.title = reference.kind === 'memory' ? `${reference.name} · 记忆卡片` : `${reference.name} · 第 ${referenceLineLabel(reference)} 行`
  chip.className = 'group mx-0.5 inline-flex h-7 max-w-[min(18rem,75vw)] select-none items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 align-middle text-[11px] leading-none text-[var(--text-primary)]'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.tabIndex = -1
  remove.dataset.removeComposerReference = reference.id
  remove.setAttribute('aria-label', `移除引用 ${reference.name}`)
  remove.className = 'mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-secondary)]'

  const fileIcon = document.createElement('span')
  fileIcon.className = 'block text-[10px] font-semibold text-sky-500 group-hover:hidden'
  fileIcon.textContent = reference.kind === 'catalog' ? '目' : reference.kind === 'plan' ? '计' : reference.kind === 'memory' ? '忆' : '章'
  const removeIcon = document.createElement('span')
  removeIcon.className = 'hidden text-sm leading-none group-hover:block'
  removeIcon.textContent = '×'
  remove.append(fileIcon, removeIcon)

  const name = document.createElement('span')
  name.className = 'max-w-40 truncate'
  name.textContent = reference.name
  const lines = document.createElement('span')
  lines.className = 'ml-1 shrink-0 text-[var(--text-tertiary)]'
  lines.textContent = reference.kind === 'memory' ? '卡片' : referenceLineLabel(reference)
  chip.setAttribute('aria-label', reference.kind === 'memory'
    ? `记忆引用：${reference.name}`
    : `${referenceKindLabel(reference)}引用：${reference.name}，第 ${referenceLineLabel(reference)} 行`)
  chip.append(remove, name, lines)
  return chip
}

function readComposerContent(root: HTMLDivElement, knownReferences: ComposerReference[]): ParsedComposerContent {
  const referenceMap = new Map(knownReferences.map((reference) => [reference.id, reference]))
  const references: ComposerReference[] = []
  let draft = ''
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      draft += node.textContent ?? ''
      continue
    }
    if (!(node instanceof HTMLElement)) continue
    const referenceId = node.dataset.composerReference
    if (referenceId) {
      const reference = referenceMap.get(referenceId)
      if (reference) references.push({ ...reference, offset: draft.length })
      continue
    }
    if (node.tagName === 'BR') {
      draft += '\n'
      continue
    }
    draft += node.textContent ?? ''
  }
  return { draft, references }
}

function writeComposerContent(root: HTMLDivElement, draft: string, references: ComposerReference[]): void {
  root.replaceChildren()
  const ordered = [...references].sort((left, right) => left.offset - right.offset)
  let cursor = 0
  for (const reference of ordered) {
    const offset = Math.max(cursor, Math.min(draft.length, reference.offset))
    if (offset > cursor) root.append(document.createTextNode(draft.slice(cursor, offset)))
    root.append(createReferenceNode(reference))
    cursor = offset
  }
  if (cursor < draft.length) root.append(document.createTextNode(draft.slice(cursor)))
}

function insertPlainText(root: HTMLDivElement, value: string): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
    root.append(document.createTextNode(value))
    return
  }
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const text = document.createTextNode(value)
  range.insertNode(text)
  range.setStartAfter(text)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function AgentComposer({
  novelId,
  voiceScopeKey,
  voiceDisabled = false,
  running,
  stopping = false,
  disabled = false,
  onSend,
  onStop,
  onContinue,
  creativeFreedom,
  onCreativeFreedomChange,
  qualityMode,
  modelTier,
  modelOptions,
  onModelTierChange,
  customModels,
  customModelId,
  onCustomModelChange,
  reasoningSelections,
  onReasoningEffortChange,
  onOpenModelSettings,
  referenceOptions,
  skills = [],
  onOpenSkillManager,
}: AgentComposerProps) {
  useLayoutEffect(() => { activateComposerDraft(voiceScopeKey) }, [voiceScopeKey])
  // 草稿与附件存在全局 store：面板在沉浸/普通视图间重挂载时不丢失未发送内容
  const prompt = useAgentStore((state) => state.composerDraft)
  const attachments = useAgentStore((state) => state.composerAttachments)
  const setAttachments = useAgentStore((state) => state.setComposerAttachments)
  const addAttachment = useAgentStore((state) => state.addComposerAttachment)
  const removeAttachment = useAgentStore((state) => state.removeComposerAttachment)
  const references = useAgentStore((state) => state.composerReferences)
  const setComposerContent = useAgentStore((state) => state.setComposerContent)
  const addComposerReference = useAgentStore((state) => state.addComposerReference)
  const uploading = useAgentStore((state) => state.composerUploading)
  const bumpUploading = useAgentStore((state) => state.bumpComposerUploading)
  // 手动指定的技能同样提升到全局：面板重挂载后选中态不丢
  const pinnedSkillIds = useAgentStore((state) => state.composerSkillIds)
  const pinnedSubagent = useAgentStore((state) => state.composerSubagent)
  const toggleComposerSkill = useAgentStore((state) => state.toggleComposerSkill)
  const setComposerSkillIds = useAgentStore((state) => state.setComposerSkillIds)
  // 启动中（建会话 + 启动 run 的网络往返）：成功后才清空草稿，避免内容“瞬间消失”观感
  const [sending, setSending] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const [referenceSearch, setReferenceSearch] = useState('')
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [editingReasoningTier, setEditingReasoningTier] = useState<Exclude<CreditModelTier, 'custom'> | null>(null)
  // 手机端模型二级列表改为受控视图：触屏没有 hover，靠 focus-within 显示会残留/溢出，
  // 点击「模型」行进入模型列表、返回或选中后回到根视图；桌面端仍走 hover/focus 行为完全不变
  const [mobileModelsOpen, setMobileModelsOpen] = useState(false)
  const [mobileModelSheetOpen, setMobileModelSheetOpen] = useState(false)
  const { info: voiceNotice } = useToast()
  const editorRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const creativeModeRef = useRef<HTMLDetailsElement | null>(null)
  const attachmentMenuRef = useRef<HTMLDetailsElement | null>(null)
  const modelMenuRef = useRef<HTMLDetailsElement | null>(null)
  const voiceBookmark = useRef<{ scope: string; signature: string; offset: number; preceding: string[] } | null>(null)
  const [pendingVoice, setPendingVoice] = useState<{ scope: string; text: string } | null>(null)
  const voiceUndo = useRef<{ scope: string; after: string; draft: string; references: ComposerReference[] } | null>(null)
  const caretAfterVoice = useRef<number | null>(null)
  const scope = voiceScopeKey ?? ''
  const voice = useVoiceInput({
    scopeKey: scope,
    disabled: !scope || voiceDisabled || disabled || running || sending || uploading > 0,
    onNotice: voiceNotice,
    onTranscript: (text) => {
      const bookmark = voiceBookmark.current
      if (!bookmark || bookmark.scope !== scope || !text.trim()) return
      const current = useAgentStore.getState()
      if (composerSignature(current.composerDraft, current.composerReferences) !== bookmark.signature) {
        setPendingVoice({ scope, text })
        return
      }
      applyVoiceText(text, bookmark.offset, bookmark.preceding)
    },
  })
  const voiceActive = voice.state !== 'idle' && voice.state !== 'checking'

  useEffect(() => {
    voiceBookmark.current = null
    voiceUndo.current = null
    caretAfterVoice.current = null
    setPendingVoice(null)
    setMobileModelSheetOpen(false)
  }, [scope])

  function applyVoiceText(text: string, offset?: number, preceding?: string[]) {
    const current = useAgentStore.getState()
    const result = insertVoiceTranscript(current.composerDraft, current.composerReferences, text, offset, preceding)
    voiceUndo.current = { scope, after: composerSignature(result.draft, result.references), draft: current.composerDraft, references: current.composerReferences }
    caretAfterVoice.current = result.caret
    setComposerContent(result.draft, result.references)
    setPendingVoice(null)
  }

  function captureVoiceBookmark() {
    const editor = editorRef.current
    const content = editor ? readComposerContent(editor, references) : { draft: prompt, references }
    let offset = content.draft.length
    let preceding = content.references.map((reference) => reference.id)
    const selection = window.getSelection()
    if (editor && selection?.rangeCount && editor.contains(selection.getRangeAt(0).endContainer)) {
      const range = selection.getRangeAt(0).cloneRange()
      range.setStart(editor, 0)
      const prefix = document.createElement('div')
      prefix.append(range.cloneContents())
      const parsed = readComposerContent(prefix, references)
      offset = parsed.draft.length
      preceding = parsed.references.map((reference) => reference.id)
    }
    voiceBookmark.current = { scope, signature: composerSignature(content.draft, content.references), offset, preceding }
    setComposerContent(content.draft, content.references)
    for (const menu of [attachmentMenuRef, modelMenuRef, creativeModeRef]) menu.current?.removeAttribute('open')
  }

  const imageCount = attachments.filter((attachment) => attachment.kind === 'image').length
  const fileCount = attachments.filter((attachment) => attachment.kind === 'file').length
  const imageFull = imageCount >= MAX_AGENT_IMAGE_COUNT
  const fileFull = fileCount >= MAX_AGENT_FILE_COUNT

  const canSend =
    !disabled && !sending && !voiceActive && !pendingVoice && uploading === 0 && (!isComposerBlank(prompt) || references.length > 0)
  const showContinue = Boolean(onContinue) && isComposerBlank(prompt) && references.length === 0 && attachments.length === 0
  const canContinue = showContinue && !running && !disabled && !sending && !voiceActive && !pendingVoice && uploading === 0
  const continueLock = useRef(false)
  const sendLock = useRef(false)
  const currentScope = useRef(scope)
  currentScope.current = scope
  async function handleContinue() {
    if (!canContinue || !onContinue || continueLock.current) return
    continueLock.current = true
    setSending(true)
    try { await onContinue() } finally { continueLock.current = false; setSending(false) }
  }
  const activeBuiltInModel = modelOptions.find((item) => item.tier === modelTier)
  const activeCustomModel = modelTier === 'custom' ? customModels.find((item) => item.id === customModelId) : undefined
  const activeModelKey = modelTier === 'custom' && activeCustomModel ? `custom:${activeCustomModel.id}` : `tier:${modelTier}`
  const activeModelLabel = activeCustomModel?.displayName ?? activeBuiltInModel?.label ?? '极速'
  const activeReasoningEfforts = orderedReasoningEfforts(activeCustomModel?.reasoningEfforts ?? activeBuiltInModel?.reasoningEfforts ?? ['high'])
  const [styleLearningOpen, setStyleLearningOpen] = useState(false)
  const storedActiveEffort = reasoningSelections[activeModelKey]
  const activeReasoningEffort = storedActiveEffort && activeReasoningEfforts.includes(storedActiveEffort)
    ? storedActiveEffort
    : activeCustomModel?.defaultReasoningEffort ?? activeBuiltInModel?.defaultReasoningEffort ?? 'high'

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const current = readComposerContent(editor, references)
    const domReferenceIds = Array.from(editor.querySelectorAll<HTMLElement>('[data-composer-reference]'))
      .map((node) => node.dataset.composerReference)
      .filter(Boolean)
    const desiredReferenceIds = references.map((reference) => reference.id)
    if (
      composerSignature(current.draft, current.references) !== composerSignature(prompt, references)
      || JSON.stringify(domReferenceIds) !== JSON.stringify(desiredReferenceIds)
    ) {
      writeComposerContent(editor, prompt, references)
    }
  }, [prompt, references])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (voiceActive || caretAfterVoice.current === null || !editor) return
    let remaining = caretAfterVoice.current
    caretAfterVoice.current = null
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    for (const node of Array.from(editor.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue
      const length = node.textContent?.length ?? 0
      if (remaining <= length) { range.setStart(node, remaining); range.collapse(true); break }
      remaining -= length
    }
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [prompt, references, voiceActive])

  const syncComposerFromDom = (): ParsedComposerContent => {
    const editor = editorRef.current
    if (!editor) return { draft: prompt, references }
    const next = readComposerContent(editor, references)
    setComposerContent(next.draft, next.references)
    return next
  }

  const uploadOne = async (kind: 'image' | 'file', name: string, dataUrl: string) => {
    const origin = scope
    if (origin) updateComposerDraft(origin, draft => ({ ...draft, composerUploading: draft.composerUploading + 1 }))
    else bumpUploading(1)
    try {
      const meta = await uploadAgentAttachment({ kind, name, dataUrl })
      if (origin) updateComposerDraft(origin, draft => ({ ...draft, composerAttachments: [...draft.composerAttachments, meta] }))
      else addAttachment(meta)
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : '附件上传失败，请重试。')
    } finally {
      if (origin) updateComposerDraft(origin, draft => ({ ...draft, composerUploading: Math.max(0, draft.composerUploading - 1) }))
      else bumpUploading(-1)
    }
  }

  const processIncomingFiles = async (files: File[]) => {
    if (files.length === 0) return
    setAttachError(null)
    let remainingImages = MAX_AGENT_IMAGE_COUNT - imageCount
    let remainingFiles = MAX_AGENT_FILE_COUNT - fileCount
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        if (remainingImages <= 0) {
          setAttachError(`最多添加 ${MAX_AGENT_IMAGE_COUNT} 张参考图，超出的已忽略。`)
          continue
        }
        remainingImages -= 1
        try {
          const dataUrl = await prepareAgentImage(file)
          await uploadOne('image', file.name || `粘贴图片-${Date.now()}.png`, dataUrl)
        } catch (error) {
          setAttachError(error instanceof Error ? error.message : '图片处理失败，请重试。')
        }
        continue
      }

      if (remainingFiles <= 0) {
        setAttachError(`最多添加 ${MAX_AGENT_FILE_COUNT} 个文件，超出的已忽略。`)
        continue
      }
      const invalid = validateAgentFile(file)
      if (invalid) {
        setAttachError(invalid)
        continue
      }
      remainingFiles -= 1
      try {
        await uploadOne('file', file.name, await readFileAsDataUrl(file))
      } catch (error) {
        setAttachError(error instanceof Error ? error.message : '文件读取失败，请重试。')
      }
    }
  }

  const handlePickImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) {
      return
    }
    await processIncomingFiles(files)
  }

  const handlePickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) {
      return
    }
    await processIncomingFiles(files)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (voiceActive) { event.preventDefault(); return }
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (files.length > 0) {
      event.preventDefault()
      void processIncomingFiles(files)
      return
    }
    event.preventDefault()
    insertPlainText(event.currentTarget, event.clipboardData.getData('text/plain'))
    syncComposerFromDom()
  }

  const attachReference = async (input: Omit<ComposerReference, 'offset'>) => {
    let reference = input
    if (reference.kind === 'chapter' && !reference.text) {
      const chapterId = reference.id.replace(/^chapter:/, '')
      bumpUploading(1)
      try {
        const chapter = await getChapterContent(novelId, chapterId)
        reference = {
          ...reference,
          text: chapter.content,
          endLine: Math.max(1, chapter.content.split('\n').length),
        }
      } catch (error) {
        setAttachError(error instanceof Error ? error.message : '章节引用读取失败，请重试。')
        return
      } finally {
        if (scope) updateComposerDraft(scope, draft => ({ ...draft, composerUploading: Math.max(0, draft.composerUploading - 1) }))
        else bumpUploading(-1)
      }
    }
    if (scope) updateComposerDraft(scope, draft => ({ ...draft, composerReferences: [...draft.composerReferences.filter(item => item.id !== reference.id), { ...reference, offset: draft.composerDraft.length }] }))
    else addComposerReference({ ...reference, offset: prompt.length })
    if (currentScope.current === scope) window.requestAnimationFrame(() => editorRef.current?.focus())
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    if (voiceActive) return
    const transferredReference = parseComposerReferenceTransfer(event.dataTransfer.getData(COMPOSER_REFERENCE_MIME))
    if (transferredReference) {
      await attachReference(transferredReference)
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) void processIncomingFiles(files)
  }

  const filteredReferenceOptions = referenceOptions.filter((reference) => {
    const keyword = referenceSearch.trim().toLocaleLowerCase('zh-CN')
    return !keyword || reference.name.toLocaleLowerCase('zh-CN').includes(keyword)
  })

  // 技能可能被在技能区关闭或删除：只信当前可用列表，避免发送陈旧 id
  const pinnedSkills = pinnedSkillIds
    .map((skillId) => skills.find((skill) => skill.id === skillId))
    .filter((skill): skill is AgentSkillListItem => Boolean(skill))

  const handleSend = async () => {
    const current = syncComposerFromDom()
    if ((isComposerBlank(current.draft) && current.references.length === 0) || disabled || sending || sendLock.current || voiceActive || pendingVoice || uploading > 0) {
      return
    }
    const effectivePrompt = buildComposerPrompt(current.draft, current.references)
    if (pinnedSubagent && pinnedSubagent.novelId !== novelId) {
      setAttachError('指定的子 Agent 不属于当前作品，请取消后重新选择。')
      return
    }
    const pending = attachments
    const pinned = pinnedSkills.map((skill) => skill.id)
    const sendingScope = scope
    sendLock.current = true
    setSending(true)
    try {
      if (pinnedSubagent) await onSend(effectivePrompt, pending, creativeFreedom, qualityMode, pinned, pinnedSubagent.id)
      else await onSend(effectivePrompt, pending, creativeFreedom, qualityMode, pinned)
      if (sendingScope) updateComposerDraft(sendingScope, draft => draft.composerDraft === current.draft ? { ...draft, composerDraft: '', composerReferences: [], composerAttachments: [], composerSkillIds: [], composerSubagent: draft.composerSubagent?.id === pinnedSubagent?.id ? null : draft.composerSubagent } : draft)
      if (currentScope.current !== sendingScope) return
      setComposerContent('', [])
      setAttachments([])
      setComposerSkillIds([])
      if (useAgentStore.getState().composerSubagent?.id === pinnedSubagent?.id) useAgentStore.setState({ composerSubagent: null })
      setAttachError(null)
    } catch {
      // 面板已展示错误提示；保留草稿与附件供用户重试
    } finally {
      sendLock.current = false
      setSending(false)
      editorRef.current?.focus()
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (voiceActive) { event.preventDefault(); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      const undo = voiceUndo.current
      if (undo?.scope === scope && undo.after === composerSignature(useAgentStore.getState().composerDraft, useAgentStore.getState().composerReferences)) {
        event.preventDefault()
        setComposerContent(undo.draft, undo.references)
        voiceUndo.current = null
        return
      }
    }
    if (event.key === 'Backspace' && !prompt && references.length > 0) {
      event.preventDefault()
      setComposerContent('', references.slice(0, -1))
      return
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      insertPlainText(event.currentTarget, '\n')
      syncComposerFromDom()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleEditorClick = (event: MouseEvent<HTMLDivElement>) => {
    if (voiceActive) return
    const removeButton = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-composer-reference]')
    if (!removeButton) return
    event.preventDefault()
    removeButton.closest<HTMLElement>('[data-composer-reference]')?.remove()
    syncComposerFromDom()
    editorRef.current?.focus()
  }

  return (
    <div
      onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true) }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false) }}
      onDrop={(event) => void handleDrop(event)}
      className={`agent-composer-glass relative z-[80] rounded-[20px] border bg-[var(--studio-composer-bg,var(--surface-default))] p-2.5 shadow-sm transition-colors ${dragActive ? 'border-[var(--text-primary)]' : 'border-[var(--border-subtle)]'}`}
    >
      {dragActive ? <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-[16px] bg-[var(--surface-default)]/95 text-xs font-medium text-[var(--text-primary)]">松开即可添加引用、图片或文件</div> : null}
      {pinnedSubagent ? <div className="mb-2 flex items-center gap-2 px-1 text-[11px] text-[var(--text-primary)]"><span className="min-w-0 truncate">本轮子 Agent：{pinnedSubagent.name}</span><button type="button" disabled={sending || voiceActive} onClick={() => useAgentStore.setState({ composerSubagent: null })} aria-label="取消指定子 Agent" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--surface-muted)]"><X className="h-3.5 w-3.5" /></button></div> : null}
      {pinnedSkills.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
          {pinnedSkills.map((skill) => (
            <span
              key={skill.id}
              title={`本轮指定技能：${skill.name}`}
              className="inline-flex max-w-[min(16rem,70vw)] items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
            >
              <Wrench className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" />
              <span className="truncate">{skill.name}</span>
              <button
                type="button"
                disabled={voiceActive}
                onClick={() => toggleComposerSkill(skill.id)}
                aria-label={`取消指定技能 ${skill.name}`}
                className="shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
          {attachments.map((attachment) =>
            attachment.kind === 'image' ? (
              <div key={attachment.id} className="group relative h-14 w-14 shrink-0">
                <img
                  src={attachment.url}
                  alt={attachment.name}
                  className="h-14 w-14 rounded-lg border border-[var(--border-subtle)] object-cover"
                />
                <button
                  type="button"
                  disabled={voiceActive}
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`移除图片 ${attachment.name}`}
                  className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--surface-contrast)] text-[var(--text-contrast)] opacity-85 transition-opacity hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div
                key={attachment.id}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-1.5 text-[11px] text-[var(--text-primary)]"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                <span className="max-w-32 truncate" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="shrink-0 text-[var(--text-secondary)]">
                  {formatAttachmentSize(attachment.size)}
                </span>
                <button
                  type="button"
                  disabled={voiceActive}
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`移除文件 ${attachment.name}`}
                  className="shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ),
          )}
          {uploading > 0 && (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[var(--text-secondary)]">
              <LoaderCircle className="h-4 w-4 animate-spin" />
            </div>
          )}
        </div>
      )}
      {attachError && (
        <p className="mb-1.5 px-1 text-[11px] text-red-500">{attachError}</p>
      )}
      <div className="relative min-h-12">
        {isComposerBlank(prompt) && references.length === 0 ? (
          <span className="pointer-events-none absolute left-1.5 top-1 text-sm leading-6 text-[var(--text-secondary)]">
            告诉我要做什么，我会自主完成…
          </span>
        ) : null}
        <div
          ref={editorRef}
          role="textbox"
          aria-label="Agent 提示词"
          aria-multiline="true"
          contentEditable={!disabled && !voiceActive && !sending}
          suppressContentEditableWarning
          onInput={syncComposerFromDom}
          onClick={handleEditorClick}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className="max-h-40 min-h-12 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1.5 py-1 text-sm leading-7 text-[var(--text-primary)] focus:outline-none data-[disabled=true]:opacity-50"
          data-disabled={disabled}
        />
      </div>
      {pendingVoice?.scope === scope ? <div className="px-1.5 py-2 text-xs text-[var(--text-secondary)]" role="status">草稿已变化，转写文字尚未插入。<div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{pendingVoice.text}</div><button type="button" disabled={disabled || running || sending || voiceActive} className="mr-3 min-h-11 underline disabled:opacity-50" onClick={() => { if (!disabled && !running && !sending && !voiceActive) applyVoiceText(pendingVoice.text) }}>插入到末尾</button><button type="button" className="min-h-11" onClick={() => setPendingVoice(null)}>放弃</button></div> : null}
      {voiceActive ? <AgentVoiceInputBar voice={voice} /> : null}
      {styleLearningOpen ? <StyleLearningDialog key={novelId} novelId={novelId} initialModel={modelTier === 'basic' ? undefined : { modelTier, customModelId, reasoningEffort: activeReasoningEffort }} onClose={() => setStyleLearningOpen(false)} /> : null}
      {mobileModelSheetOpen && !disabled && !voiceActive ? <AgentMobileModelSheet
        modelOptions={modelOptions} customModels={customModels} modelTier={modelTier} customModelId={customModelId}
        activeModelLabel={activeModelLabel} activeReasoningEffort={activeReasoningEffort} activeReasoningEfforts={activeReasoningEfforts}
        onTier={onModelTierChange} onCustom={id => { onCustomModelChange(id); onModelTierChange('custom') }}
        onReasoning={effort => onReasoningEffortChange(activeModelKey, effort)}
        onSettings={() => { setMobileModelSheetOpen(false); onOpenModelSettings() }} onClose={() => setMobileModelSheetOpen(false)}
      /> : null}
      <div className={cn('mt-1.5 flex items-center justify-between gap-1', voiceActive && 'hidden')}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(event) => void handlePickImages(event)}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={AGENT_FILE_ACCEPT}
            multiple
            className="hidden"
            onChange={(event) => void handlePickFiles(event)}
          />
          <details ref={attachmentMenuRef} className="group/attach relative" data-disabled={disabled || undefined}>
            <summary
              onClick={(event) => { if (disabled) event.preventDefault() }}
              className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] group-data-[disabled=true]/attach:pointer-events-none group-data-[disabled=true]/attach:opacity-40 [&::-webkit-details-marker]:hidden"
              aria-label="添加内容"
              title="添加图片、文件、作品引用，或指定本轮技能与子 Agent"
            >
              <Plus className="h-4 w-4 transition-transform group-open/attach:rotate-45" />
            </summary>
            <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[min(32rem,60dvh)] w-64 overflow-y-auto overscroll-contain rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] py-1 shadow-[0_14px_34px_rgba(15,23,42,0.16)]">
              <button
                type="button"
                disabled={imageFull}
                onClick={() => { imageInputRef.current?.click(); attachmentMenuRef.current?.removeAttribute('open') }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <Image className="h-4 w-4 text-[var(--text-tertiary)]" />
                <span><span className="block font-medium">上传图片</span><span className="mt-0.5 block text-[10px] text-[var(--text-tertiary)]">PNG、JPG、WebP，最多 6 张</span></span>
              </button>
              <button
                type="button"
                disabled={fileFull}
                onClick={() => { fileInputRef.current?.click(); attachmentMenuRef.current?.removeAttribute('open') }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <FileText className="h-4 w-4 text-[var(--text-tertiary)]" />
                <span><span className="block font-medium">上传文件</span><span className="mt-0.5 block text-[10px] text-[var(--text-tertiary)]">PDF、DOCX、TXT、Markdown</span></span>
              </button>
              <button type="button" onClick={() => { attachmentMenuRef.current?.removeAttribute('open'); setStyleLearningOpen(true) }} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"><BookOpenText className="h-4 w-4 text-[var(--text-tertiary)]" /><span><span className="block font-medium">样章学习与写作风格</span><span className="mt-0.5 block text-[10px] text-[var(--text-tertiary)]">查看文件、学习依据和自动使用的规则</span></span></button>
              <div className="mx-3 my-1 border-t border-[var(--border-subtle)]" />
              {voice.modelReady ? <button type="button" onClick={() => { attachmentMenuRef.current?.removeAttribute('open'); void voice.removeModel() }} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"><Mic className="h-4 w-4 shrink-0" /><span><span className="block">删除本机语音包</span><span className="mt-0.5 block text-[10px] text-[var(--text-tertiary)]">释放存储空间，下次使用可重新下载</span></span></button> : null}
              <button
                type="button"
                onClick={() => setReferencePickerOpen((value) => !value)}
                className="flex w-full items-start gap-3 px-3 py-2 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
                aria-expanded={referencePickerOpen}
              >
                <BookOpenText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 flex-1"><span className="block font-medium text-[var(--text-primary)]">引用作品内容</span><span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-tertiary)]">点选目录、计划或章节，也可从作品树拖入。</span></span>
                <ChevronDown className={`mt-0.5 h-3.5 w-3.5 transition-transform ${referencePickerOpen ? 'rotate-180' : ''}`} />
              </button>
              {referencePickerOpen ? (
                <div className="border-t border-[var(--border-subtle)] px-2 pb-2 pt-2">
                  <input
                    value={referenceSearch}
                    onChange={(event) => setReferenceSearch(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                    placeholder="搜索章节或计划"
                    className="h-8 w-full border border-[var(--border-subtle)] bg-[var(--surface-default)] px-2.5 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]"
                  />
                  <div className="mt-1 max-h-52 overflow-y-auto [scrollbar-width:thin]">
                    {filteredReferenceOptions.length > 0 ? filteredReferenceOptions.map((reference) => (
                      <button
                        key={reference.id}
                        type="button"
                        onClick={() => {
                          void attachReference(reference)
                          attachmentMenuRef.current?.removeAttribute('open')
                          setReferencePickerOpen(false)
                          setReferenceSearch('')
                        }}
                        className="flex w-full items-center gap-2 px-2 py-2 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                      >
                        <span className="w-6 shrink-0 text-[10px] text-[var(--text-tertiary)]">{reference.kind === 'chapter' ? '章节' : reference.kind === 'plan' ? '计划' : '目录'}</span>
                        <span className="min-w-0 flex-1 truncate">{reference.name}</span>
                      </button>
                    )) : <p className="px-2 py-4 text-center text-[11px] text-[var(--text-tertiary)]">没有匹配的作品内容</p>}
                  </div>
                </div>
              ) : null}
              {/* 技能分组：不选时服务端自动路由，选了就是作者明确指令，本轮必定加载 */}
              <SubagentPicker key={novelId} novelId={novelId} selectedId={pinnedSubagent?.id} disabled={disabled || sending || voiceActive} onSelect={item => {
                useAgentStore.setState({ composerSubagent: { id: item.id, name: item.name, novelId } })
                attachmentMenuRef.current?.removeAttribute('open')
                editorRef.current?.focus()
              }} />
              {(skills.length > 0 || onOpenSkillManager) ? (
                <>
                  <div className="mx-3 my-1 border-t border-[var(--border-subtle)]" />
                  <button
                    type="button"
                    onClick={() => setSkillPickerOpen((value) => !value)}
                    className="flex w-full items-start gap-3 px-3 py-2 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
                    aria-expanded={skillPickerOpen}
                  >
                    <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[var(--text-primary)]">
                        技能{pinnedSkills.length > 0 ? `（已选 ${pinnedSkills.length}/${MAX_PINNED_SKILLS}）` : ''}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-tertiary)]">不选时由 Agent 自动判断；点选后本轮必定调用。</span>
                    </span>
                    <ChevronDown className={`mt-0.5 h-3.5 w-3.5 transition-transform ${skillPickerOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {skillPickerOpen ? (
                    <div className="border-t border-[var(--border-subtle)] px-2 pb-2 pt-1">
                      <div className="max-h-52 overflow-y-auto [scrollbar-width:thin]">
                        {skills.length > 0 ? skills.map((skill) => {
                          const picked = pinnedSkillIds.includes(skill.id)
                          const sourceLabel = skillSourceLabel(skill.source)
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() => toggleComposerSkill(skill.id)}
                              aria-pressed={picked}
                              className="flex w-full items-start gap-2 px-2 py-2 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"
                            >
                              <span className={cn('mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border', picked ? 'border-transparent bg-[var(--surface-contrast)] text-[var(--text-contrast)]' : 'border-[var(--border-strong)]')}>
                                {picked ? <Check className="h-2.5 w-2.5" /> : null}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate font-medium">{skill.name}</span>
                                  {sourceLabel ? <span className="shrink-0 rounded-[4px] border border-[var(--border-subtle)] px-1 text-[9px] leading-4 text-[var(--text-tertiary)]">{sourceLabel}</span> : null}
                                </span>
                                <span className="mt-0.5 block truncate text-[10px] leading-4 text-[var(--text-tertiary)]">{skillHintLine(skill)}</span>
                              </span>
                            </button>
                          )
                        }) : <p className="px-2 py-4 text-center text-[11px] text-[var(--text-tertiary)]">当前作品还没有启用的技能</p>}
                      </div>
                      {onOpenSkillManager ? (
                        <button
                          type="button"
                          onClick={() => {
                            attachmentMenuRef.current?.removeAttribute('open')
                            setSkillPickerOpen(false)
                            onOpenSkillManager()
                          }}
                          className="mt-1 flex w-full items-center gap-1.5 border-t border-[var(--border-subtle)] px-2 pt-2 text-left text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                          <span>管理技能（新建、导入、启用）</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </details>
          <details ref={creativeModeRef} className="group/mode relative" data-disabled={disabled || undefined}>
            <summary
              onClick={(event) => { if (disabled) event.preventDefault() }}
              aria-label="创作模式"
              title={CREATIVE_MODES.find((item) => item.value === creativeFreedom)?.description}
              className={cn('flex h-7 cursor-pointer list-none items-center gap-1.5 px-1 text-[11px] transition-colors hover:text-[var(--text-primary)] group-data-[disabled=true]/mode:pointer-events-none group-data-[disabled=true]/mode:opacity-45 [&::-webkit-details-marker]:hidden', creativeFreedom === 'bold' ? 'text-orange-600 dark:text-orange-400' : 'text-[var(--text-secondary)]')}
            >
              {(() => { const ActiveIcon = CREATIVE_MODES.find((item) => item.value === creativeFreedom)?.icon ?? Feather; return <ActiveIcon className="h-3.5 w-3.5" /> })()}
              <span className="max-w-16 truncate mobile:hidden">{CREATIVE_MODES.find((item) => item.value === creativeFreedom)?.label}</span>
              <ChevronDown className="h-3 w-3 transition-transform group-open/mode:rotate-180" />
            </summary>
            <div className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_14px_34px_rgba(15,23,42,0.16)] motion-safe:origin-bottom-left motion-safe:animate-[agent-menu-in_150ms_cubic-bezier(0.2,0.8,0.2,1)]">
              {CREATIVE_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  title={mode.description}
                  onClick={() => {
                    onCreativeFreedomChange(mode.value)
                    creativeModeRef.current?.removeAttribute('open')
                  }}
                  aria-pressed={mode.value === creativeFreedom}
                  className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors first:rounded-t-[11px] last:rounded-b-[11px] ${mode.value === creativeFreedom ? 'bg-[var(--surface-muted)]' : 'bg-[var(--surface-default)] hover:bg-[var(--surface-muted)]'}`}
                >
                  <mode.icon className={cn('mt-0.5 h-4 w-4 shrink-0', mode.value === 'bold' ? 'text-orange-600 dark:text-orange-400' : 'text-[var(--text-secondary)]')} />
                  <span className="min-w-0"><span className={cn('block text-xs font-medium', mode.value === 'bold' ? 'text-orange-600 dark:text-orange-400' : 'text-[var(--text-primary)]')}>{mode.label}</span><span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-tertiary)]">{mode.description}</span></span>
                </button>
              ))}
            </div>
          </details>
          <details ref={modelMenuRef} className="group/model relative z-[120] ml-auto min-w-0" data-disabled={disabled || undefined} onToggle={(event) => { if (!(event.currentTarget as HTMLDetailsElement).open) { setMobileModelsOpen(false); setEditingReasoningTier(null) } }}>
            <summary
              onClick={(event) => {
                if (disabled) { event.preventDefault(); return }
                if (window.innerWidth < 768) {
                  event.preventDefault()
                  editorRef.current?.blur()
                  modelMenuRef.current?.removeAttribute('open')
                  setMobileModelSheetOpen(true)
                }
              }}
              aria-label="模型档位"
              title="选择模型性能与 Credits 倍率"
              className="flex h-7 cursor-pointer list-none items-center gap-1 rounded-full px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] group-data-[disabled=true]/model:pointer-events-none group-data-[disabled=true]/model:opacity-45 [&::-webkit-details-marker]:hidden"
            >
              <span className="min-w-0 max-w-24 truncate">{activeModelLabel}</span>
              <span className="text-[9px] text-[var(--text-tertiary)]">{activeReasoningEffort}</span>
              <ChevronDown className="h-3 w-3 transition-transform group-open/model:rotate-180" />
            </summary>
            <div className={cn('absolute bottom-full right-0 z-[140] mb-2 w-[248px] overflow-visible rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[0_18px_46px_rgba(15,23,42,0.18)] motion-safe:origin-bottom-right motion-safe:animate-[agent-menu-in_150ms_cubic-bezier(0.2,0.8,0.2,1)]', mobileModelsOpen && 'mobile:invisible mobile:pointer-events-none')}>
              <div className="group/models relative">
                <button type="button" onClick={() => setMobileModelsOpen(true)} className="flex h-9 w-full items-center justify-between rounded-[9px] px-2.5 text-xs hover:bg-[var(--surface-muted)]"><span className="font-medium text-[var(--text-primary)]">模型</span><span className="inline-flex max-w-36 items-center gap-1 truncate text-[var(--text-secondary)]">{activeModelLabel}<ChevronRight className="h-3 w-3" /></span></button>
                <div className={cn('invisible absolute bottom-0 right-[calc(100%-1px)] z-[150] w-60 translate-x-1 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 opacity-0 shadow-[0_18px_46px_rgba(15,23,42,0.2)] transition-[opacity,transform,visibility] duration-150 ease-out group-hover/models:visible group-hover/models:translate-x-0 group-hover/models:opacity-100 group-focus-within/models:visible group-focus-within/models:translate-x-0 group-focus-within/models:opacity-100 mobile:left-0 mobile:right-0 mobile:w-auto mobile:translate-x-0 mobile:overflow-y-auto mobile:max-h-72 mobile:transition-none mobile:pointer-events-auto', mobileModelsOpen ? 'mobile:visible mobile:opacity-100' : 'mobile:hidden')}>
                  <button type="button" onClick={(event) => { event.currentTarget.blur(); setEditingReasoningTier(null); setMobileModelsOpen(false) }} className="mb-1 hidden h-8 w-full items-center gap-1.5 rounded-[8px] px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] mobile:flex" aria-label="返回模型菜单"><ChevronRight className="h-3.5 w-3.5 rotate-180" />返回</button>
                  <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">可用内置模型</p>
                  {editingReasoningTier ? (() => {
                    const option = modelOptions.find((item) => item.tier === editingReasoningTier)
                    if (!option) return null
                    const efforts = orderedReasoningEfforts(option.reasoningEfforts)
                    const modelKey = `tier:${option.tier}`
                    const selected = reasoningSelections[modelKey] && efforts.includes(reasoningSelections[modelKey])
                      ? reasoningSelections[modelKey]
                      : option.defaultReasoningEffort
                    return <div className="absolute bottom-0 right-[calc(100%+7px)] z-[160] w-52 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-1.5 shadow-[0_18px_46px_rgba(15,23,42,0.2)] motion-safe:origin-bottom-right motion-safe:animate-[agent-menu-in_140ms_cubic-bezier(.2,.8,.2,1)] mobile:left-0 mobile:right-0 mobile:bottom-0 mobile:w-auto mobile:overflow-y-auto mobile:max-h-64 mobile:shadow-none">
                      <div className="flex items-center justify-between px-2 pb-1 pt-1"><div><p className="text-[10px] text-[var(--text-tertiary)]">{option.label}</p><p className="text-xs font-medium text-[var(--text-primary)]">思考模式</p></div><button type="button" onClick={() => setEditingReasoningTier(null)} className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-tertiary)] hover:bg-[var(--surface-muted)]" aria-label="关闭思考模式设置"><X className="h-3.5 w-3.5" /></button></div>
                      {efforts.map((effort) => <button key={effort} type="button" onClick={() => onReasoningEffortChange(modelKey, effort)} className={cn('flex h-9 w-full items-center justify-between rounded-[8px] px-2.5 text-left text-xs transition-colors hover:bg-[var(--surface-muted)]', effort === selected && 'bg-[var(--surface-muted)] font-medium')}><span>{REASONING_LABELS[effort]}</span><span className="inline-flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">{effort}{effort === selected ? <Check className="h-3.5 w-3.5 text-[var(--text-primary)]" /> : null}</span></button>)}
                    </div>
                  })() : null}
                  {modelOptions.filter((option) => option.available).map((option) => <div key={option.tier} className={cn('group/model-row flex h-9 w-full items-center rounded-[8px] hover:bg-[var(--surface-muted)]', option.tier === modelTier && 'bg-[var(--surface-muted)] font-medium')}><button type="button" onClick={() => { onModelTierChange(option.tier); modelMenuRef.current?.removeAttribute('open'); setEditingReasoningTier(null); setMobileModelsOpen(false) }} className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-xs"><span className="min-w-0 flex-1 truncate">{option.label}</span><span className="text-[10px] tabular-nums text-[var(--text-tertiary)] group-hover/model-row:hidden group-focus-within/model-row:hidden mobile:hidden">{option.multiplier.toFixed(1)}x</span>{option.tier === modelTier ? <Check className="h-3.5 w-3.5 group-hover/model-row:hidden group-focus-within/model-row:hidden" /> : null}</button><button type="button" onClick={(event) => { event.stopPropagation(); setEditingReasoningTier(option.tier) }} className="mr-1 hidden h-7 items-center gap-1 rounded-[7px] px-2 text-[10px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-default)] group-hover/model-row:inline-flex group-focus-within/model-row:inline-flex mobile:inline-flex" aria-label={`编辑${option.label}思考模式`}><Pencil className="h-3 w-3" />编辑</button></div>)}
                  {customModels.some((model) => model.enabled) ? <><div className="mx-2 my-1 border-t border-[var(--border-subtle)]" /><p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">自定义模型</p>{customModels.filter((model) => model.enabled).map((model) => <button key={model.id} type="button" onClick={() => { onCustomModelChange(model.id); onModelTierChange('custom'); modelMenuRef.current?.removeAttribute('open'); setMobileModelsOpen(false) }} className={cn('flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-xs hover:bg-[var(--surface-muted)]', modelTier === 'custom' && model.id === customModelId && 'bg-[var(--surface-muted)] font-medium')}><span className="min-w-0 flex-1 truncate">{model.displayName}</span><span className="text-[10px] text-[var(--text-tertiary)]">BYOK</span>{modelTier === 'custom' && model.id === customModelId ? <Check className="h-3.5 w-3.5" /> : null}</button>)}</> : null}
                </div>
              </div>
              <div className="flex h-9 items-center justify-between rounded-[9px] px-2.5 text-xs"><span className="font-medium text-[var(--text-primary)]">速度</span><span className="text-[var(--text-secondary)]">标准</span></div>
              <details className="group/advanced rounded-[10px] open:bg-[var(--surface-muted)]/65">
                <summary className="flex h-9 cursor-pointer list-none items-center justify-between rounded-[9px] px-2.5 text-xs hover:bg-[var(--surface-muted)] [&::-webkit-details-marker]:hidden"><span className="font-medium text-[var(--text-primary)]">高级</span><ChevronDown className="h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform group-open/advanced:rotate-180" /></summary>
                <div className="px-3 pb-3 pt-1">
                  <ReasoningSlider efforts={activeReasoningEfforts} value={activeReasoningEffort} modelLabel={activeModelLabel} onChange={effort => onReasoningEffortChange(activeModelKey, effort)} />
                </div>
              </details>
              <div className="mx-2 my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => { modelMenuRef.current?.removeAttribute('open'); onOpenModelSettings() }}
                className="flex h-9 w-full items-center gap-2 rounded-[9px] px-2.5 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                <Settings2 className="h-4 w-4 text-[var(--text-tertiary)]" /> 配置自定义模型
              </button>
            </div>
          </details>
        </div>
        <button type="button" disabled={voice.disabled} onPointerDown={captureVoiceBookmark} onClick={(event) => { if (event.detail === 0 || !voiceBookmark.current || voiceBookmark.current.scope !== scope) captureVoiceBookmark(); void voice.start() }} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 disabled:opacity-35 mobile:h-11 mobile:w-11" aria-label="语音输入" title="语音输入 · 本机离线转写"><Mic className="h-[18px] w-[18px]" /></button>
        {running && !canSend && !sending ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-contrast)] text-[var(--text-contrast)] transition-opacity hover:opacity-85 mobile:h-11 mobile:w-11"
            aria-label={stopping ? '正在停止运行' : '停止运行'}
            title={stopping ? '正在取消请求并保存进度…' : '停止运行'}
          >
            {stopping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void (showContinue && !running ? handleContinue() : handleSend())}
            disabled={showContinue && !running ? !canContinue : !canSend}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-contrast)] text-[var(--text-contrast)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35 mobile:h-11 mobile:w-11"
            aria-label={running ? '加入待发队列' : showContinue ? '继续运行' : '发送'}
            title={running ? '当前任务结束后发送' : showContinue ? '继续当前任务' : '发送'}
          >
            {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : showContinue && !running ? <Play className="h-4 w-4 fill-current" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  )
}
