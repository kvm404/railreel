/**
 * Social feed logic (pure): chat log bookkeeping, the subtitle-ticker window, floating-reaction
 * lane assignment, and input hygiene. The host is the hub — it validates, stamps, and broadcasts;
 * these helpers keep both ends' bookkeeping identical and unit-tested.
 */

/** A chat line as the UI consumes it. */
export interface ChatEntry {
  from: string
  text: string
  /** Host wall-clock ms stamp (ordering + ticker freshness). */
  at: number
}

/** A reaction event as the UI consumes it. */
export interface ReactionEvent {
  /** Locally-assigned sequence (animation key + lane math). */
  seq: number
  from: string
  emoji: string
  at: number
}

/** Chat text hygiene: trim, collapse exotic whitespace, and bound the length. */
export const CHAT_MAX_CHARS = 280
export function sanitizeChatText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_CHARS)
}

/** Reaction hygiene: a short grapheme string only (an emoji, not a paragraph). */
export function isValidReaction(emoji: string): boolean {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 8 && emoji.trim() === emoji
}

/** Append with a cap: the log keeps the most recent `cap` entries (old lines scroll away). */
export function appendCapped<T>(log: readonly T[], entry: T, cap: number): T[] {
  const next = [...log, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * The subtitle ticker shows the last few FRESH lines: at most `max`, none older than `windowMs`.
 * Anything older belongs to the sheet, not the film.
 */
export function tickerWindow(log: readonly ChatEntry[], nowMs: number, windowMs = 6000, max = 3): ChatEntry[] {
  const fresh: ChatEntry[] = []
  for (let i = log.length - 1; i >= 0 && fresh.length < max; i--) {
    const entry = log[i]
    if (!entry || nowMs - entry.at > windowMs) break // log is time-ordered — earlier is older
    fresh.unshift(entry)
  }
  return fresh
}

/**
 * Floating reactions ride an edge lane; concurrent ones must not overlap. Lanes are assigned
 * round-robin by sequence over `laneCount` slots — deterministic, collision-free for up to
 * `laneCount` concurrent reactions, and identical on every device.
 */
export function reactionLane(seq: number, laneCount = 4): number {
  return ((seq % laneCount) + laneCount) % laneCount
}

/**
 * Cap simultaneous floating reactions: of everything younger than `lifeMs`, keep only the
 * newest `max` (a burst becomes a lively trickle instead of an emoji wall over the film).
 */
export function liveReactions(events: readonly ReactionEvent[], nowMs: number, lifeMs = 2500, max = 4): ReactionEvent[] {
  const alive = events.filter((e) => nowMs - e.at < lifeMs)
  return alive.length > max ? alive.slice(alive.length - max) : alive
}
