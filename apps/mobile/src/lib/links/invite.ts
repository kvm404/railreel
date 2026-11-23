/**
 * Invite links (`railreel://join?...`) arriving from outside the join form: a tapped link
 * (Android deep link — cold start or while running), or a pasted chat message that contains one.
 * Everything is validated with the protocol decoder before it can reach the join flow, so a
 * malformed or hostile link is dropped here, never half-handled later. Pure + unit-tested.
 */

import { decodeJoinUrl, isVersionMismatch, JOIN_URL_HOST, JOIN_URL_SCHEME, type JoinPayload } from '../protocol'

export type Invite = {
  /** The validated link, trimmed — hand this to `connect()`. */
  url: string
  /** The host address the link points at (shown to the guest for transparency). */
  host: string
  payload: JoinPayload
}

const LINK_IN_TEXT = new RegExp(`${JOIN_URL_SCHEME}://${JOIN_URL_HOST}\\?[^\\s"'<>]+`, 'i')

/** Pull a `railreel://join?...` link out of arbitrary text (e.g. a pasted chat message). */
export function findInviteUrl(text: string | null | undefined): string | null {
  if (!text) return null
  const m = LINK_IN_TEXT.exec(text)
  return m ? m[0] : null
}

/** A valid invite for `raw` (a bare link, or text containing one), or null. */
export function parseInvite(raw: string | null | undefined): Invite | null {
  const candidate = findInviteUrl(raw)
  if (!candidate) return null
  try {
    const payload = decodeJoinUrl(candidate)
    return { url: candidate, host: payload.host, payload }
  } catch {
    return null
  }
}

/** `raw` holds a real RailReel invite, just from another protocol version ("update both phones"). */
export function isOtherVersionInvite(raw: string | null | undefined): boolean {
  const candidate = findInviteUrl(raw)
  if (!candidate) return false
  try {
    decodeJoinUrl(candidate)
    return false
  } catch (e) {
    return isVersionMismatch(e)
  }
}
