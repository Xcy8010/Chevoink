/** Also serialized into immutable release-entry.js. Keep this renderer self-contained:
 * no imports, module closures or runtime helpers. Refresh remains caller-owned. */
import type { PublicAppRelease } from './contracts/app-release.js'

export function showAppReleaseUpdateNotice(message: string, onRefresh: () => void, release?: Pick<PublicAppRelease, 'notes' | 'activatedAt'> | null) {
  if (document.getElementById('app-release-update')) return
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const overflow = document.body.style.overflow
  const dialog = document.createElement('dialog')
  dialog.id = 'app-release-update'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'app-release-update-title')
  dialog.setAttribute('aria-describedby', 'app-release-update-description')
  dialog.setAttribute('data-native-back-dismiss', '')
  const studio = Boolean(document.querySelector('.studio-workspace'))
  if (studio) dialog.className = 'studio-workspace'
  Object.assign(dialog.style, { position: "fixed", inset: "0", margin: "auto", width: "min(440px,calc(100vw - 32px))", maxWidth: "none", maxHeight: "calc(100dvh - 32px)", overflow: "hidden", border: "1px solid var(--border-subtle,#d4d4d4)", borderRadius: "16px", padding: "0", color: "var(--text-primary,#171717)", boxShadow: "0 24px 80px #0004", fontFamily: "var(--studio-body-font,inherit)" })
  dialog.style.background = studio ? 'var(--surface-default,#fff)' : 'var(--surface-elevated,#fff)'
  const style = document.createElement('style')
  style.textContent = '#app-release-update::backdrop{background:rgba(0,0,0,.45)}#app-release-update button:focus-visible{outline:2px solid var(--text-primary,#171717);outline-offset:2px}#app-release-update button:not([data-primary]):hover{background:var(--surface-muted,#eee)}#app-release-update button[data-primary]:hover{filter:brightness(.9)}@media(max-width:767px){#app-release-update-close{width:44px!important;height:44px!important}}'
  const frame = document.createElement('div')
  Object.assign(frame.style, { display: "flex", maxHeight: "calc(100dvh - 34px)", flexDirection: "column" })
  const header = document.createElement('header')
  Object.assign(header.style, { display: "flex", flexShrink: "0", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "16px 20px", borderBottom: "1px solid var(--border-subtle,#d4d4d4)" })
  const title = document.createElement('h2')
  title.id = 'app-release-update-title'; title.textContent = '应用版本已更新'
  Object.assign(title.style, { margin: "0", fontSize: "17px", fontWeight: "600", lineHeight: "26px" })
  const close = document.createElement('button')
  close.id = 'app-release-update-close'; close.type = 'button'; close.textContent = '×'
  close.setAttribute('aria-label', '关闭版本更新提示')
  Object.assign(close.style, { display: "inline-flex", width: "36px", height: "36px", flexShrink: "0", alignItems: "center", justifyContent: "center", padding: "0", border: "0", borderRadius: "8px", background: "transparent", color: "var(--text-secondary,#666)", fontSize: "24px", lineHeight: "1", cursor: "pointer" })
  close.onclick = () => dialog.close()
  header.append(title, close)
  const body = document.createElement('div')
  Object.assign(body.style, { minHeight: "0", overflowY: "auto", overscrollBehavior: "contain", padding: "20px", fontSize: "14px", lineHeight: "24px" })
  const description = document.createElement('p')
  description.id = 'app-release-update-description'; description.textContent = message + ' 刷新后即可使用。'
  Object.assign(description.style, { margin: "0", overflowWrap: "anywhere" })
  const hint = document.createElement('p')
  hint.textContent = '也可以稍后刷新，继续留在当前界面。'
  Object.assign(hint.style, { margin: "8px 0 0", color: "var(--text-secondary,#666)", fontSize: "13px" })
  body.append(description)
  if (release?.activatedAt) {
    const date = new Date(release.activatedAt)
    if (Number.isFinite(date.getTime())) {
      const time = document.createElement('time')
      time.dateTime = release.activatedAt
      const formatted = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).format(date)
      time.textContent = `更新时间 ${formatted}（北京时间）`
      Object.assign(time.style, { display: 'block', marginTop: '4px', color: 'var(--text-secondary,#666)', fontSize: '13px' })
      body.append(time)
    }
  }
  if (release?.notes) {
    const notes = document.createElement('section')
    Object.assign(notes.style, { margin: '16px 0', paddingTop: '12px', borderTop: '1px solid var(--border-subtle,#d4d4d4)' })
    const heading = document.createElement('h3')
    heading.textContent = '更新日志'
    Object.assign(heading.style, { margin: '0', fontSize: '14px', fontWeight: '600' })
    notes.append(heading)
    for (const [label, entries] of [['新增', release.notes.features], ['修复', release.notes.fixes], ['调整', release.notes.changes]] as const) {
      if (!entries.length) continue
      const group = document.createElement('h4')
      group.textContent = label
      Object.assign(group.style, { margin: '8px 0 0', fontSize: '13px', fontWeight: '600' })
      const list = document.createElement('ul')
      Object.assign(list.style, { margin: '2px 0 0', paddingInlineStart: '20px', listStyleType: 'disc', overflowWrap: 'anywhere' })
      for (const entry of entries) {
        const item = document.createElement('li')
        item.textContent = entry
        list.append(item)
      }
      notes.append(group, list)
    }
    body.append(notes)
  }
  body.append(hint)
  const footer = document.createElement('footer')
  Object.assign(footer.style, { display: "flex", flexShrink: "0", justifyContent: "flex-end", gap: "8px", padding: "14px 20px", borderTop: "1px solid var(--border-subtle,#d4d4d4)" })
  const later = document.createElement('button')
  later.type = 'button'; later.textContent = '稍后'
  Object.assign(later.style, { minHeight: "44px", padding: "0 16px", border: "1px solid var(--border-strong,#aaa)", borderRadius: "8px", background: "transparent", color: "inherit", font: "inherit", fontSize: "14px", cursor: "pointer" })
  later.onclick = () => dialog.close()
  const refresh = document.createElement('button')
  refresh.type = 'button'; refresh.textContent = '立即刷新'; refresh.setAttribute('data-primary', '')
  Object.assign(refresh.style, { minHeight: "44px", padding: "0 16px", border: "1px solid var(--border-strong,#aaa)", borderRadius: "8px", background: "var(--surface-contrast,#171717)", color: "var(--text-contrast,#fff)", font: "inherit", fontSize: "14px", fontWeight: "600", cursor: "pointer" })
  refresh.onclick = () => { refresh.disabled = true; onRefresh() }
  footer.append(later, refresh); frame.append(header, body, footer); dialog.append(style, frame)
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close() })
  dialog.addEventListener('close', () => {
    document.body.style.overflow = overflow
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  })
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const buttons = Array.from(dialog.querySelectorAll('button')).filter(button => !button.disabled)
    const first = buttons[0], last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  })
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return
    const rect = dialog.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close()
  })
  ;(document.fullscreenElement ?? document.body).appendChild(dialog)
  document.body.style.overflow = 'hidden'
  dialog.showModal()
  later.focus({ preventScroll: true })
}
