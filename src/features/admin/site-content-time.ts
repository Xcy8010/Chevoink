/** Admin content dates always use Asia/Shanghai (UTC+8), independent of browser zone. */
const offsetMs = 8 * 60 * 60 * 1000
export function formatShanghaiDateInput(value:string) {
  if (!value) return ''
  return new Date(Date.parse(value) + offsetMs).toISOString().slice(0,16)
}
export function parseShanghaiDateInput(value:string) {
  if (!value) return ''
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return ''
  const date = new Date(value + ':00+08:00')
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}