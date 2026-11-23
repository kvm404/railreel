/**
 * Android Back resolution, kept pure so the ordering rules are unit-testable (no React Native).
 *
 * Screens and overlays register handlers scoped to the route they're mounted in. On a Back press
 * the navigator asks the registry for the TOP route only, so a screen that's animating out can
 * never swallow the press. Overlays (chat sheet, QR scanner, end-of-session card) outrank the
 * screen's own exit, and within a layer the most recently registered wins (the one drawn on top).
 * A handler returns true when it consumed the press; if nothing does, the navigator falls back to
 * popping the stack.
 */

export type BackLayer = 'screen' | 'overlay'
export type BackHandlerFn = () => boolean

export interface BackEntry {
  id: number
  /** Route key the handler belongs to (only the top route is ever consulted). */
  scope: string
  layer: BackLayer
  handle: BackHandlerFn
}

const LAYER_RANK: Record<BackLayer, number> = { overlay: 0, screen: 1 }

/** The handlers to consult for `scope`, in priority order: overlays first, then newest first. */
export function orderBackEntries(entries: readonly BackEntry[], scope: string): BackEntry[] {
  return entries
    .filter((e) => e.scope === scope)
    .sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || b.id - a.id)
}

/** Offer the press to each handler in priority order; true as soon as one consumes it. */
export function dispatchBack(entries: readonly BackEntry[], scope: string): boolean {
  for (const e of orderBackEntries(entries, scope)) {
    if (e.handle()) return true
  }
  return false
}

export interface BackRegistry {
  register: (scope: string, layer: BackLayer, handle: BackHandlerFn) => () => void
  dispatch: (scope: string) => boolean
}

export function createBackRegistry(): BackRegistry {
  let entries: BackEntry[] = []
  let nextId = 0
  return {
    register(scope, layer, handle) {
      const entry: BackEntry = { id: nextId++, scope, layer, handle }
      entries = [...entries, entry]
      return () => {
        entries = entries.filter((e) => e !== entry)
      }
    },
    // `entries` is replaced, never mutated, so a handler that unregisters (e.g. an overlay closing
    // itself) can't disturb the iteration in progress.
    dispatch: (scope) => dispatchBack(entries, scope),
  }
}
