export default function LoadingMark({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="加载中" className={className}>
      <span className="boot-mark" aria-hidden="true" />
    </div>
  )
}
