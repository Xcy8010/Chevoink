import type { InputHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  wrapperAs?: 'label' | 'span'
  leading?: ReactNode
  trailing?: ReactNode
}

export default function TextInput({ className, leading, trailing, wrapperAs: Wrapper = 'label', ...props }: TextInputProps) {
  return (
    <Wrapper
      className={cn(
        'flex h-10 w-full items-center gap-3 rounded-[var(--radius-pill)] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 text-sm text-[var(--text-secondary)] transition-colors md:h-11',
        'focus-within:border-[var(--accent-border)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]',
        className,
      )}
    >
      {leading}
      <input className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[var(--text-primary)] outline-none" {...props} />
      {trailing}
    </Wrapper>
  )
}
