/**
 * Social feed logic (pure): chat log bookkeeping, the subtitle-ticker window, floating-reaction
 * lane assignment, and input hygiene. The host is the hub — it validates, stamps, and broadcasts;
 * these helpers keep both ends' bookkeeping identical and unit-tested.
 */

/** A chat line as the UI consumes it. */
export interface ChatEntry {
  /**
   * Locally-assigned, strictly increasing id (list keys + the unread cursor). Never reused, so it
   * keeps counting after the capped log starts dropping its oldest lines.
   */
  id: number
  from: string
  text: string
  /** Host wall-clock ms stamp — the time shown next to the line (the room's one clock). */
  at: number
  /**
   * THIS phone's wall-clock ms when the line arrived — ticker freshness. Never compare `at`
   * with the local clock: host and guest clocks can be tens of seconds apart.
   */
  receivedAt: number
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
 * The subtitle ticker shows the last few FRESH lines: at most `max`, none received more than
 * `windowMs` ago (`nowMs` is this phone's Date.now()). Anything older belongs to the sheet.
 */
export function tickerWindow(log: readonly ChatEntry[], nowMs: number, windowMs = 6000, max = 3): ChatEntry[] {
  const fresh: ChatEntry[] = []
  for (let i = log.length - 1; i >= 0 && fresh.length < max; i--) {
    const entry = log[i]
    if (!entry || nowMs - entry.receivedAt > windowMs) break // log is arrival-ordered — earlier is older
    fresh.unshift(entry)
  }
  return fresh
}

/** Newest chat id in the log, or `fallback` when it is empty (the read cursor's "caught up" mark). */
export function lastChatId(log: readonly ChatEntry[], fallback = 0): number {
  return log.length > 0 ? log[log.length - 1]!.id : fallback
}

/**
 * Unread lines for the chat badge: entries newer than the read cursor (`seenId`, the newest id
 * the reader has seen), excluding our own. A monotonic cursor rather than a length diff — once
 * the log hits its cap, new lines replace old ones without changing the length.
 */
export function unreadCount(log: readonly ChatEntry[], seenId: number): number {
  let n = 0
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!
    if (entry.id <= seenId) break // ids increase with position — everything earlier is read
    if (entry.from !== 'You') n++
  }
  return n
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
