import { ArrowDown } from 'lucide-react'

export function AgentReturnOrb({ visible, onReturn }: { visible: boolean; onReturn: () => void }) {
  return (
    <div className="agent-return-anchor">
      <button type="button" className="agent-return-orb" data-visible={visible}
        aria-label="返回当前任务进度" aria-hidden={!visible} tabIndex={visible ? 0 : -1}
        disabled={!visible} onClick={onReturn}>
        <span className="agent-return-dots" aria-hidden><i /><i /><i /></span>
        <ArrowDown className="agent-return-arrow" size={17} aria-hidden />
      </button>
    </div>
  )
}
