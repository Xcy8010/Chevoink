/** Output takes over immediately. Retaining a fading hint beside newly visible
 * prose caused two competing progress indicators, including with reduced motion. */
export function ProcessingHint({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <p
      role="status"
      className="animate-fade-in px-1 text-xs text-[var(--text-secondary)] motion-reduce:animate-none"
    >
      <span className="agent-processing-shimmer">正在处理...</span>
    </p>
  )
}
