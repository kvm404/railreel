import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { GUEST_KEEP_AWAKE_TAG, guestShouldStayAwake, type GuestAwakeInput } from '@/lib/session/keepAwake'

/**
 * Holds the guest keep-awake tag while lib/session/keepAwake says so (foreground guest session:
 * boarding board, paused Player), and releases it on every way out, unmount included. Uses its
 * own tag, so the host's session-long tag is never touched.
 */
export function useGuestKeepAwake(role: GuestAwakeInput['role'], clientPhase: GuestAwakeInput['clientPhase']): void {
  const [appState, setAppState] = useState<string>(AppState.currentState)
  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState)
    return () => sub.remove()
  }, [])

  const awake = guestShouldStayAwake({ role, clientPhase, appState })
  useEffect(() => {
    if (!awake) return
    activateKeepAwakeAsync(GUEST_KEEP_AWAKE_TAG).catch(() => {})
    return () => {
      deactivateKeepAwake(GUEST_KEEP_AWAKE_TAG).catch(() => {})
    }
  }, [awake])
}
