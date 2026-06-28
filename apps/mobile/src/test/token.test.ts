import { describe, it, expect } from 'vitest'
import {
  base64url,
  generateGrant,
  generateSessionId,
  generateToken,
  isValidSecret,
  newSession,
  type RandomBytes,
} from '@/lib/protocol'

/** Deterministic byte source for tests: fills with a repeating ramp from `seed`. */
const ramp =
  (seed = 0): RandomBytes =>
  (n) =>
    Uint8Array.from({ length: n }, (_, i) => (seed + i) & 0xff)

describe('base64url', () => {
  it('matches the RFC 4648 §4 vector "Man" → "TWFu"', () => {
    expect(base64url(Uint8Array.of(77, 97, 110))).toBe('TWFu')
  })

  it('emits url-safe chars (- and _) instead of + and /', () => {
    // 0xFB,0xFF would be "+/" / "8" in standard base64; url-safe uses "-" and "_".
    const s = base64url(Uint8Array.of(0xfb, 0xff))
    expect(s).toBe('-_8')
    expect(s).not.toMatch(/[+/=]/)
  })

  it('handles 1- and 2-byte tails without padding', () => {
    expect(base64url(Uint8Array.of(0))).toBe('AA')
    expect(base64url(Uint8Array.of(0, 0))).toBe('AAA')
    expect(base64url(new Uint8Array())).toBe('')
  })
})

describe('secret generation', () => {
  it('mints url-safe secrets with real length', () => {
    const r = ramp(1)
    expect(generateToken(r)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generateToken(r).length).toBeGreaterThanOrEqual(20) // 16 bytes → 22 chars
    expect(generateGrant(r).length).toBeGreaterThanOrEqual(20)
  })

  it('is deterministic given the same bytes and differs given different bytes', () => {
    expect(generateToken(ramp(0))).toBe(generateToken(ramp(0)))
    expect(generateToken(ramp(0))).not.toBe(generateToken(ramp(1)))
  })

  it('newSession returns a short id and a long token', () => {
    const { sessionId, token } = newSession(ramp(7))
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThan(sessionId.length)
    expect(generateSessionId(ramp(7))).toBe(sessionId)
  })
})

describe('isValidSecret', () => {
  it('accepts a real generated token', () => {
    expect(isValidSecret(generateToken(ramp(3)))).toBe(true)
  })

  it('rejects short, empty, wrong-type, or non-base64url input', () => {
    expect(isValidSecret('short')).toBe(false)
    expect(isValidSecret('')).toBe(false)
    expect(isValidSecret(undefined)).toBe(false)
    expect(isValidSecret(123 as unknown)).toBe(false)
    expect(isValidSecret('has spaces and is long enough!!')).toBe(false)
    expect(isValidSecret('contains+slash/and=pad====')).toBe(false)
  })

  it('honors a custom minimum length', () => {
    expect(isValidSecret('abcd', 4)).toBe(true)
    expect(isValidSecret('abc', 4)).toBe(false)
  })
})
