/**
 * The host Player's last word on unmount: a paused state for the room. It must only ever be
 * spoken into the session the Player was mounted for — a leave() and the navigation reset land in
 * the same commit, so by the time the cleanup runs the session may already be gone or replaced.
 */
export interface HostExitInput {
  /** This Player called leave() itself (the last-rendered session still looks live). */
  leftSession: boolean
  role: 'host' | 'client' | 'none'
  /** The session's identity now, and when the Player mounted. */
  joinCode: string | null
  mountedJoinCode: string | null
}

export function shouldPublishHostExit(i: HostExitInput): boolean {
  return !i.leftSession && i.role === 'host' && i.joinCode != null && i.joinCode === i.mountedJoinCode
}
