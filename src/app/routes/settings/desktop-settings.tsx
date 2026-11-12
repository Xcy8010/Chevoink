import { useEffect, useState } from 'react'
import { ExternalLink, Info, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useToast } from '@/components/ui/toast-context'
import { SectionTitle, SettingsGroup, SettingsRow } from './settings-row'

export default function DesktopSettings() {
  const toast = useToast()
  const [info, setInfo] = useState<{ version: string; settingsActions?: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    void invoke<{ version: string; settingsActions?: number }>('desktop_get_info').then(value => {
      if (!cancelled) setInfo(value)
    }).catch(() => { /* Older hosts keep their native menu; never expose unrestricted IPC. */ })
    return () => { cancelled = true }
  }, [])
  async function act(action: 'update' | 'browser') {
    if (busy) return
    if (info?.settingsActions !== 1) {
      toast.info('此版本请使用原客户端菜单，或手动安装新版客户端。')
      return
    }
    setBusy(true)
    try { await invoke('desktop_settings_action', { action }) }
    catch { toast.error('客户端操作未完成，请稍后重试。') }
    finally { setBusy(false) }
  }
  return <section id="settings-about">
    <SectionTitle>Windows 客户端</SectionTitle>
    <SettingsGroup>
      <SettingsRow icon={<RefreshCw className="h-[18px] w-[18px]" />} title="检查客户端更新" caption="当前测试版使用手动下载安装" onClick={() => void act('update')} />
      <SettingsRow icon={<ExternalLink className="h-[18px] w-[18px]" />} title="在浏览器打开官网" onClick={() => void act('browser')} />
      <SettingsRow icon={<Info className="h-[18px] w-[18px]" />} title="版本信息" caption={`Windows x64 · ${info?.version ?? navigator.userAgent.match(/ChevoinkDesktop\/([\d.]+)/)?.[1] ?? '未知'}`} chevron="none" />
    </SettingsGroup>
  </section>
}
