/**
 * Should a guest phone hold its screen awake? expo-video keeps the display on only while a film
 * is actually PLAYING, so a guest left on the boarding board (waiting for approval, a download,
 * the host to start) or on a paused Player would otherwise time out and lock — and miss the
 * start or the resume until someone wakes it. So: awake for the whole foreground guest session,
 * released the moment it ends (left, denied, torn down) or the app leaves the foreground (a
 * backgrounded follower pauses itself; nothing on screen needs the display).
 *
 * The host holds its own tag for the life of the session; this one never touches it.
 */

export const GUEST_KEEP_AWAKE_TAG = 'railreel-guest'

export interface GuestAwakeInput {
  role: 'none' | 'host' | 'client'
  clientPhase: 'idle' | 'connecting' | 'requested' | 'approved' | 'downloading' | 'ready' | 'denied'
  /** React Native AppState ('active' | 'background' | 'inactive' | 'unknown' | 'extension'). */
  appState: string
}

export function guestShouldStayAwake(i: GuestAwakeInput): boolean {
  if (i.role !== 'client') return false
  if (i.clientPhase === 'denied' || i.clientPhase === 'idle') return false
  // 'unknown' is the launch state before the first event: the app is on screen.
  return i.appState === 'active' || i.appState === 'unknown'
}
