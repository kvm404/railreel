/**
 * A tiny reactive store for the OS "reduce motion" preference. Reanimated's `useReducedMotion`
 * snapshots the setting at startup, so ambient loops would keep running after the user flips it
 * mid-session. This store is fed by AccessibilityInfo (see hooks/useReduceMotion) and read through
 * `useSyncExternalStore`, so every subscriber re-renders the moment the setting changes.
 *
 * Pure (no React Native imports) so it is unit-tested.
 */

export type ReduceMotionSource = {
  /** Resolves the current OS setting. */
  isEnabled: () => Promise<boolean>
  /** Subscribes to changes; returns the unsubscribe. */
  subscribe: (onChange: (enabled: boolean) => void) => () => void
}

export type ReduceMotionStore = {
  getSnapshot: () => boolean
  /** useSyncExternalStore-compatible: the first listener starts the source, the last stops it. */
  subscribe: (listener: () => void) => () => void
}

export function createReduceMotionStore(source: ReduceMotionSource, initial = false): ReduceMotionStore {
  let value = initial
  let resolved = false
  const listeners = new Set<() => void>()
  let stopSource: (() => void) | null = null

  const set = (next: boolean) => {
    if (next === value) return
    value = next
    listeners.forEach((l) => l())
  }

  const start = () => {
    resolved = false
    source
      .isEnabled()
      .then((v) => {
        // A change event that landed before the initial query resolves is newer — keep it.
        if (!resolved) set(v)
      })
      .catch(() => {})
    stopSource = source.subscribe((v) => {
      resolved = true
      set(v)
    })
  }

  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopSource?.()
          stopSource = null
        }
      }
    },
  }
}
