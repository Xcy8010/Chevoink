export default function LoadingMark({ className, label = '加载中' }: { className?: string; label?: string }) {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="agent-loading-mark" aria-hidden="true" />
    </div>
  )
}
