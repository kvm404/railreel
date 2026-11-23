import { createContext, useContext, useEffect, useRef } from 'react'
import type { BackHandlerFn, BackLayer, BackRegistry } from '@/lib/nav/backStack'

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
  /**
   * Replace the whole stack with a single route. Use for every session ending, so Back from the
   * landing screen can't resurrect a torn-down Lobby/Player. Never dropped by an in-flight
   * transition (a terminal redirect must land), and a no-op if that route is already the only one.
   */
  reset: (name: RouteName, params?: NavParams) => void
  goBack: () => void
  canGoBack: boolean
}

export const NavContext = createContext<NavApi | null>(null)
/** The Navigator's Back registry (internal — screens use `useBackHandler`). */
export const BackRegistryContext = createContext<BackRegistry | null>(null)
/** Key of the route a component is mounted under, so its Back handlers are scoped to it. */
export const RouteKeyContext = createContext<string | null>(null)

export function useNavigation(): NavApi {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNavigation must be used within <Navigator>')
  return ctx
}

/**
 * Claim Android hardware Back while mounted (and `enabled`). Return true when handled; false lets
 * the next handler (and finally the navigator's pop) take it. Overlays use `layer: 'overlay'` so
 * they close before the screen exits. Ordering rules live in lib/nav/backStack.
 *
 * The latest `handler` is always called, but registration only changes with `enabled`/`layer`,
 * so a re-render never reshuffles priority.
 */
export function useBackHandler(
  handler: BackHandlerFn,
  { enabled = true, layer = 'screen' }: { enabled?: boolean; layer?: BackLayer } = {},
): void {
  const registry = useContext(BackRegistryContext)
  const scope = useContext(RouteKeyContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!registry || !scope || !enabled) return
    return registry.register(scope, layer, () => handlerRef.current())
  }, [registry, scope, enabled, layer])
}
