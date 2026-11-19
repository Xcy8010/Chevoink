import type { Components } from 'react-markdown'

export function safeMarkdownUrl(value: string): string {
  if (/^#[\w-]+$/.test(value)) return value
  if (!/^https?:\/\//i.test(value)) return ''
  try {
    const url = new URL(value)
    return url.username || url.password ? '' : url.href
  } catch { return '' }
}

export const markdownResources: Pick<Components, 'a' | 'img'> = {
  a: ({ children, href }) => href ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'}
    rel="noopener noreferrer" className="break-all underline underline-offset-2">{children}</a> : <span>{children}</span>,
  // Stored prose cannot initiate external image requests.
  img: ({ alt }) => <span className="text-[var(--text-secondary)]">{alt ? `[图片：${alt}，未自动加载]` : '[图片未自动加载]'}</span>,
}
