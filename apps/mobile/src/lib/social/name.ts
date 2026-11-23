/**
 * The name a guest joins with. The host silently drops a join with an empty name (the guest would
 * sit in 'requested' forever), and long names squeeze chat rows — so the form normalizes and gates
 * on this before anything is sent. Pure + unit-tested.
 */

/** Longest name the join form accepts (the host truncates at 40; chat rows stay readable at 24). */
export const MAX_GUEST_NAME_LENGTH = 24

/** Trim, collapse inner whitespace, and cap the length (without splitting a surrogate pair). */
export function normalizeGuestName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length > MAX_GUEST_NAME_LENGTH ? chars.slice(0, MAX_GUEST_NAME_LENGTH).join('').trimEnd() : collapsed
}

/** A name the host will accept: something is left after normalizing. */
export function isValidGuestName(raw: string): boolean {
  return normalizeGuestName(raw).length > 0
}
