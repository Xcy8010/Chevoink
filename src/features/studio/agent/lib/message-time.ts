/** All calendar comparisons intentionally use the viewer's local timezone. */
export function formatMessageTime(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) return null
  const two = (part: number) => String(part).padStart(2, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time
  const day = `${two(date.getMonth() + 1)}/${two(date.getDate())}/${time}`
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}/${day}`
}
