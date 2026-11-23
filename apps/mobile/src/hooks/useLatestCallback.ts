import { useCallback, useRef } from 'react'

/**
 * A callback with a stable identity that always runs the latest closure. For handlers passed to
 * memoized children (or native listeners) that read fresh state: the child never re-renders
 * because the handler "changed", and the handler never acts on a stale render.
 */
export function useLatestCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}
