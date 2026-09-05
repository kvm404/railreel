/**
 * Safe parsing of incoming WebSocket frames. Network input is untrusted, so every
 * frame is JSON-parsed defensively and checked against the known message types
 * before the rest of the app sees it. Pure + unit-tested.
 */

import {
  CLIENT_MSG_TYPES,
  SERVER_MSG_TYPES,
  type ClientMsg,
  type ServerMsg,
} from './messages'

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string }

function parseFrame(raw: string): ParseResult<{ t: string } & Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'not an object' }
  }
  const t = (value as Record<string, unknown>).t
  if (typeof t !== 'string') {
    return { ok: false, error: 'missing message type' }
  }
  return { ok: true, msg: value as { t: string } & Record<string, unknown> }
}

/** Validate a frame as a client→host message (used by the host). */
export function parseClientMsg(raw: string): ParseResult<ClientMsg> {
  const r = parseFrame(raw)
  if (!r.ok) return r
  if (!(CLIENT_MSG_TYPES as readonly string[]).includes(r.msg.t)) {
    return { ok: false, error: `unknown client message "${r.msg.t}"` }
  }
  return { ok: true, msg: r.msg as unknown as ClientMsg }
}

/** Validate a frame as a host→client message (used by clients). */
export function parseServerMsg(raw: string): ParseResult<ServerMsg> {
  const r = parseFrame(raw)
  if (!r.ok) return r
  if (!(SERVER_MSG_TYPES as readonly string[]).includes(r.msg.t)) {
    return { ok: false, error: `unknown server message "${r.msg.t}"` }
  }
  return { ok: true, msg: r.msg as unknown as ServerMsg }
}

/** Serialize a message for the wire. */
export function encodeMsg(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg)
}

/** Check whether a parsed client message is a well-formed playbackRequest. */
export function isPlaybackRequest(
  msg: unknown,
): msg is Extract<ClientMsg, { t: 'playbackRequest' }> {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  return (
    m.t === 'playbackRequest' &&
    typeof m.id === 'string' &&
    m.id.length > 0 &&
    typeof m.grant === 'string' &&
    m.grant.length > 0 &&
    typeof m.requestId === 'string' &&
    m.requestId.length > 0 &&
    (m.action === 'pause' || m.action === 'rewind') &&
    (m.seconds === undefined || (typeof m.seconds === 'number' && Number.isFinite(m.seconds) && m.seconds >= 0))
  )
}

/** Check whether a parsed server message is a well-formed playbackRequestDecision. */
export function isPlaybackRequestDecision(
  msg: unknown,
): msg is Extract<ServerMsg, { t: 'playbackRequestDecision' }> {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  return (
    m.t === 'playbackRequestDecision' &&
    typeof m.requestId === 'string' &&
    m.requestId.length > 0 &&
    typeof m.requesterId === 'string' &&
    m.requesterId.length > 0 &&
    typeof m.approved === 'boolean' &&
    (m.action === 'pause' || m.action === 'rewind') &&
    (m.seconds === undefined || (typeof m.seconds === 'number' && Number.isFinite(m.seconds) && m.seconds >= 0))
  )
}
