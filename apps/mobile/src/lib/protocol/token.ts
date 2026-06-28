/**
 * Session credentials: the high-entropy secrets that gate a RailReel session.
 *
 * Two kinds of secret (see docs/architecture.md §10):
 *  - the SESSION TOKEN — distributed via the QR/link, required on every WS + HTTP
 *    request; it is the "you may talk to this host" gate.
 *  - a per-client DOWNLOAD GRANT — minted by the joining client, authorized by the host
 *    only after it approves that client, and required IN ADDITION to the token on the HTTP
 *    data plane. Being on the hotspot with the token is not enough to pull bytes (§10).
 *
 * Generation is pure: it takes raw random bytes so it can be unit-tested deterministically.
 * The runtime source of those bytes (expo-crypto) lives in src/net/random.ts.
 *
 * Threat model (v1): both secrets are BEARER tokens sent over a plaintext LAN (WS + HTTP query
 * params). They stop someone who is merely on the hotspot — without the token they can't talk to
 * the host, and without an approved grant they can't pull bytes. They do NOT defend against a LAN
 * packet-sniffer who can observe and replay an approved client's URL. That is an accepted v1
 * limitation (no internet, no TLS, trusted-cabin assumption); see docs/architecture.md §10.
 */

/** Source of cryptographically-strong randomness: returns `n` fresh bytes. */
export type RandomBytes = (n: number) => Uint8Array

/** 128 bits — infeasible to guess offline, short enough for a QR/link query string. */
const TOKEN_BYTES = 16
const GRANT_BYTES = 16
/** Session id is an identifier, not a secret; keep it short. */
const SESSION_ID_BYTES = 6

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * URL-safe base64 (RFC 4648 §5), no padding. Safe inside a `?tk=`/`?g=` query value and a
 * QR/link without escaping. Pure over the input bytes.
 */
export function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number // loop guard guarantees this index exists
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64URL[b0 >> 2]
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64URL[b2 & 0x3f]
  }
  return out
}

const SECRET_RE = /^[A-Za-z0-9_-]+$/

/**
 * Shape-check an incoming token/grant before trusting it: non-empty, long enough to carry
 * real entropy, and only base64url characters (a malformed secret can never match anyway, but
 * rejecting early keeps logs clean and blocks junk from reaching the comparison).
 */
export function isValidSecret(s: unknown, minLen = 16): s is string {
  return typeof s === 'string' && s.length >= minLen && SECRET_RE.test(s)
}

/** The session secret shared via the QR/link. Required on both the WS and HTTP planes. */
export function generateToken(random: RandomBytes): string {
  return base64url(random(TOKEN_BYTES))
}

/** A per-client download grant. Minted by the client; only works once the host approves it. */
export function generateGrant(random: RandomBytes): string {
  return base64url(random(GRANT_BYTES))
}

/** A short, non-secret session identifier. */
export function generateSessionId(random: RandomBytes): string {
  return base64url(random(SESSION_ID_BYTES))
}

export interface SessionCredentials {
  sessionId: string
  token: string
}

/** Mint a fresh session id + token together (what "create session" needs). */
export function newSession(random: RandomBytes): SessionCredentials {
  return { sessionId: generateSessionId(random), token: generateToken(random) }
}
