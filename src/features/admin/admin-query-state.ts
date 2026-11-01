import { useContext } from 'react'
import { UNSAFE_NavigationContext, useLocation, useSearchParams } from 'react-router-dom'

// React Router search setters do not queue functional updates. Share the pending
// URL between fields in the same navigation so filter + page resets compose.
const pending = new WeakMap<object, { key: string; params: URLSearchParams }>()
export function useAdminQueryState(key: string, defaultValue: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const { navigator } = useContext(UNSAFE_NavigationContext)
  if (pending.get(navigator)?.key !== location.key) pending.set(navigator, { key: location.key, params: new URLSearchParams(params) })
  return [params.get(key) ?? defaultValue, value => {
    const state = pending.get(navigator)
    const next = new URLSearchParams(state?.key === location.key ? state.params : params)
    if (value === defaultValue || !value) next.delete(key)
    else next.set(key, value)
    pending.set(navigator, { key: location.key, params: next })
    setParams(next, { replace: true })
  }]
}
