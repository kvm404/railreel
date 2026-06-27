/**
 * Encode/decode the join payload carried by the QR code / deep link.
 *
 * The host shows a QR (and a tappable `railreel://join?...` link); a client scans it
 * to learn how to reach the host — IP, ports, session id, and the secret token.
 * A bare 4-digit code can't carry this offline, which is why the QR/link is the
 * robust path (see docs/architecture.md §2). Pure + unit-tested.
 */

import { PROTOCOL_VERSION, type JoinPayload } from './session'

export const JOIN_URL_SCHEME = 'railreel'
export const JOIN_URL_HOST = 'join'

export class JoinPayloadError extends Error {}

/** Build a `railreel://join?...` link from a payload. */
export function encodeJoinUrl(p: JoinPayload): string {
  const q = new URLSearchParams({
    v: String(p.v),
    host: p.host,
    ws: String(p.wsPort),
    http: String(p.httpPort),
    s: p.sessionId,
    tk: p.token,
  })
  return `${JOIN_URL_SCHEME}://${JOIN_URL_HOST}?${q.toString()}`
}

function requireStr(q: URLSearchParams, key: string): string {
  const v = q.get(key)
  if (v === null || v === '') throw new JoinPayloadError(`missing "${key}"`)
  return v
}

function requirePort(q: URLSearchParams, key: string): number {
  const n = Number(requireStr(q, key))
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new JoinPayloadError(`invalid port "${key}"`)
  }
  return n
}

/** Parse + validate a join link. Throws `JoinPayloadError` on anything malformed. */
export function decodeJoinUrl(url: string): JoinPayload {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new JoinPayloadError('not a URL')
  }
  // URL normalizes "scheme://host" — protocol keeps a trailing ":".
  if (parsed.protocol !== `${JOIN_URL_SCHEME}:`) {
    throw new JoinPayloadError(`wrong scheme "${parsed.protocol}"`)
  }
  if (parsed.host !== JOIN_URL_HOST) {
    throw new JoinPayloadError(`wrong host "${parsed.host}"`)
  }

  const q = parsed.searchParams
  const v = Number(requireStr(q, 'v'))
  if (v !== PROTOCOL_VERSION) {
    throw new JoinPayloadError(`unsupported protocol version ${v}`)
  }

  return {
    v,
    host: requireStr(q, 'host'),
    wsPort: requirePort(q, 'ws'),
    httpPort: requirePort(q, 'http'),
    sessionId: requireStr(q, 's'),
    token: requireStr(q, 'tk'),
  }
}
