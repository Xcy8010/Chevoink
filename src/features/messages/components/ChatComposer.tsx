import { ImagePlus, LoaderCircle, Send } from 'lucide-react'
import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react'

type ChatComposerProps = {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** 选中本地图片后回调（校验与读取由调用方处理） */
  onPickImage?: (file: File) => void
  isSending: boolean
}

/** 聊天输入区（X 私信风格）：+ 发图 | 无边框胶囊输入框（短文本不出现滚动条）| 圆形发送键 */
export default function ChatComposer({ value, onChange, onSend, onPickImage, isSending }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`
    // 只有内容超过最大高度才允许滚动，短文本彻底隐藏/禁用滚动
    element.style.overflowY = element.scrollHeight > 132 ? 'auto' : 'hidden'
  }, [value])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (value.trim() && !isSending) onSend()
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 允许连续选择同一张图片
    event.target.value = ''
    if (file && onPickImage) onPickImage(file)
  }

  return (
    <div className="flex items-end gap-1.5 bg-[var(--surface-default)] px-2.5 pb-[calc(var(--bottom-bar-inset)+10px)] pt-2 md:border-t md:border-[var(--border-subtle)] md:px-3 md:pb-3 md:pt-3">
      {onPickImage ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            aria-label="发送图片"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending}
            className="press-feedback inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--color-brand)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
          >
            <ImagePlus className="h-5 w-5" />
          </button>
        </>
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="发条消息"
        className="max-h-[132px] min-h-[40px] flex-1 resize-none rounded-[20px] bg-[var(--surface-muted)] px-4 py-2.5 text-sm leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />
      <button
        type="button"
        aria-label="发送"
        onClick={onSend}
        disabled={!value.trim() || isSending}
        className="press-feedback inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--color-brand)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
      >
        {isSending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
      </button>
    </div>
  )
}
