/**
 * Plain-language join failures. The raw strings that reach the store ("Error: WebSocket error",
 * "sync timed out") are accurate for a developer and useless for a friend standing in a hallway
 * holding a phone — say what probably happened and what to do, and keep the technical line as a
 * small secondary detail. Pure + unit-tested.
 */

import { VERSION_MISMATCH_MESSAGE } from '../protocol/joinPayload'

export type FriendlyError = {
  /** What to do / what happened, in the app's voice. */
  message: string
  /** The raw technical line (secondary, small), or null when it adds nothing. */
  detail: string | null
}

const UNREACHABLE = "Couldn't reach the host. Check you're on their hotspot, then try again."
const NO_ANSWER = "The host didn't answer. Check you're on their hotspot and that they're still hosting, then try again."
const CLOSED = 'The host closed the connection. Ask them for a fresh invite, then try again.'
const BAD_LINK = "That invite doesn't look right. Ask the host to share it again."
const GENERIC = "Couldn't join that cabin. Check you're on the host's hotspot, then try again."

function stripPrefix(raw: string): string {
  return raw.trim().replace(/^(?:[A-Za-z]*Error):\s*/, '')
}

/** Translate a store `error` raised while joining; null when there is nothing to show. */
export function friendlyJoinError(raw: string | null | undefined): FriendlyError | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const detail = stripPrefix(raw)
  const low = detail.toLowerCase()

  // Already a sentence meant for people — leave it alone.
  if (raw === VERSION_MISMATCH_MESSAGE) return { message: raw, detail: null }
  if (low.startsWith('bad join link')) return { message: BAD_LINK, detail }

  if (low.includes('websocket closed')) return { message: CLOSED, detail }
  if (low.includes('timed out') || low.includes('timeout')) return { message: NO_ANSWER, detail }
  if (low.includes('websocket error') || low.includes('network request failed') || low.includes('failed to connect')) {
    return { message: UNREACHABLE, detail }
  }
  return { message: GENERIC, detail }
}
