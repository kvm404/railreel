import { useSyncExternalStore } from 'react'
import { AccessibilityInfo } from 'react-native'
import { createReduceMotionStore } from '@/lib/a11y/reduceMotion'

/**
 * Live "reduce motion" preference. Unlike Reanimated's `useReducedMotion` (a startup snapshot),
 * this follows the OS setting while the app runs, so ambient loops stop/start the moment the user
 * flips it. Ambient motion (streaks, sync dots, glows) must key off this hook.
 */
const store = createReduceMotionStore({
  isEnabled: () => AccessibilityInfo.isReduceMotionEnabled(),
  subscribe: (onChange) => {
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', onChange)
    return () => sub.remove()
  },
})

export function useReduceMotion(): boolean {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
