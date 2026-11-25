import { useStudioPresence } from './use-studio-presence'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchReferral } from '@/features/account/credits-api'
import InviteCreditsDialog from '@/features/account/InviteCreditsDialog'

export default function StudioDesktopInvite({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const { rendered } = useStudioPresence(open ? true : null)
  return rendered ? <DesktopInviteContent open={open} onClose={onClose} /> : null
}

function DesktopInviteContent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const referral = useQuery({ queryKey: ['credits', 'referral'], queryFn: fetchReferral, staleTime: 60_000 })
  const [copied, setCopied] = useState(false)
  const autoCopied = useRef(false)
  const url = referral.data?.inviteUrl
  const copy = useCallback(async () => {
    if (!url || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch { /* The link stays visible for manual copying. */ }
  }, [url])
  useEffect(() => {
    if (open && url && !autoCopied.current) {
      autoCopied.current = true
      void copy()
    }
  }, [copy, open, url])
  return <InviteCreditsDialog open={open} referral={referral.data ?? null} copied={copied} onCopy={() => void copy()} onClose={onClose} />
}
