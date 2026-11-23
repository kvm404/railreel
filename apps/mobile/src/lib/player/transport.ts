/**
 * The host's Play press, as a pure decision. ExoPlayer's play() at end-of-stream only flips the
 * play intent — it does not rewind — so Play after "The End" must restart from the top
 * explicitly, and the room must be told 0 (not the player's position: the native seek lands
 * asynchronously, and a stale read would publish a playing timeline at or past EOF).
 */

/** Within this of the duration the film is at its end even without a playToEnd event. */
export const END_EPSILON_SEC = 0.5

export interface PlayPressInput {
  /** The Player is showing "The End". */
  ended: boolean
  positionSec: number
  /** 0 when unknown (no restart is inferred from the position then). */
  durationSec: number
}

export interface PlayPressPlan {
  /** Rewind to the top and play (expo-video replay()), instead of a plain play(). */
  restart: boolean
  /** The position to publish to the room with isPlaying: true. */
  fromSec: number
}

export function playPressPlan(i: PlayPressInput): PlayPressPlan {
  const pos = Number.isFinite(i.positionSec) ? Math.max(0, i.positionSec) : 0
  const atEnd = i.durationSec > 0 && pos >= i.durationSec - END_EPSILON_SEC
  if (i.ended || atEnd) return { restart: true, fromSec: 0 }
  return { restart: false, fromSec: pos }
}
