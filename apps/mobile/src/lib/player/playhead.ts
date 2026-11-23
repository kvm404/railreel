/**
 * The playhead as a tiny observable store, kept OUT of React state. The Player used to push the
 * position into state at 10Hz, which re-rendered the whole screen (controls, chat, reactions,
 * moderation) ten times a second. Now only the few readers that care subscribe — captions
 * re-render when the active cue changes, the time readout when the displayed second changes —
 * and drift correction never touches React at all.
 *
 * A seek can be `publish`ed immediately (so a paused seek or a scrub release shows the new
 * position at once) with a short hold that ignores stale native ticks still reporting the old
 * position — otherwise the filament would snap back for a frame before the player lands.
 */

export type PlayheadListener = (sec: number) => void

export interface PlayheadStore {
  get(): number
  subscribe(fn: PlayheadListener): () => void
  /** A native tick (expo-video `timeUpdate`). Ignored while a fresh seek is held and it disagrees. */
  ingest(sec: number, nowMs: number): void
  /** A position we know right now (a seek). Holds against stale ticks for `holdMs`. */
  publish(sec: number, nowMs: number, holdMs?: number): void
}

/** A tick this close to the held seek target counts as "landed" and releases the hold. */
const HOLD_TOLERANCE_SEC = 1.5
const DEFAULT_HOLD_MS = 900

const clean = (sec: number): number => (Number.isFinite(sec) && sec > 0 ? sec : 0)

export function createPlayheadStore(initialSec = 0): PlayheadStore {
  let value = clean(initialSec)
  let holdTarget: number | null = null
  let holdUntil = 0
  const listeners = new Set<PlayheadListener>()

  const emit = (sec: number) => {
    if (sec === value) return
    value = sec
    listeners.forEach((fn) => fn(sec))
  }

  return {
    get: () => value,
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    ingest(sec, nowMs) {
      const s = clean(sec)
      if (holdTarget != null) {
        if (nowMs < holdUntil && Math.abs(s - holdTarget) > HOLD_TOLERANCE_SEC) return // stale pre-seek tick
        holdTarget = null
      }
      emit(s)
    },
    publish(sec, nowMs, holdMs = DEFAULT_HOLD_MS) {
      const s = clean(sec)
      holdTarget = s
      holdUntil = nowMs + holdMs
      emit(s)
    },
  }
}
