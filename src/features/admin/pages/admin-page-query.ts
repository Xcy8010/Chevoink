import { useAdminQueryState } from '../admin-query-state'

export function useAdminNumberQuery(key: string, defaultValue: number) {
  const [raw, update] = useAdminQueryState(key, String(defaultValue))
  const value = /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : defaultValue
  return [value, (next: number | ((previous: number) => number)) => update(String(typeof next === 'function' ? next(value) : next))] as const
}
