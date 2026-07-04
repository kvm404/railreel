import { createContext, useContext } from 'react'

/**
 * Minimal navigation contract. A custom navigator (not react-navigation) keeps the
 * night-window atmosphere persistent across screens, gives us bespoke transitions, and
 * — importantly — adds no native module, so the UI keeps hot-reloading without a rebuild.
 */

export type RouteName = 'Home' | 'CreateSession' | 'JoinSession' | 'Lobby' | 'Player'
export type NavParams = Record<string, unknown>

export interface NavApi {
  navigate: (name: RouteName, params?: NavParams) => void
  replace: (name: RouteName, params?: NavParams) => void
  goBack: () => void
  canGoBack: boolean
}

export const NavContext = createContext<NavApi | null>(null)

export function useNavigation(): NavApi {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNavigation must be used within <Navigator>')
  return ctx
}
