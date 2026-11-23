import { useEffect, useRef } from 'react'

/**
 * `ref.current` is true while the component is mounted — for async handlers whose continuation
 * must not act once the screen is gone. Set on mount (not only at init) so a StrictMode
 * mount → unmount → mount cycle ends up true.
 */
export function useMountedRef() {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
