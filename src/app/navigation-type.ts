import { createContext, useContext } from 'react'
import { useNavigationType, type NavigationType } from 'react-router-dom'

export const AppNavigationTypeContext = createContext<NavigationType | null>(null)

export function useAppNavigationType() {
  const routeAction = useNavigationType()
  return useContext(AppNavigationTypeContext) ?? routeAction
}
