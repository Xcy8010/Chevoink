/** Admin wallet operations expose the full milli-Credit precision. */
export function formatAdminCredits(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}
