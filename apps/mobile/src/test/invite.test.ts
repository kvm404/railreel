import { describe, it, expect } from 'vitest'
import { encodeJoinUrl, PROTOCOL_VERSION } from '@/lib/protocol'
import { findInviteUrl, isOtherVersionInvite, parseInvite } from '@/lib/links/invite'
import { isValidGuestName, MAX_GUEST_NAME_LENGTH, normalizeGuestName } from '@/lib/social/name'
import { MAX_SRT_CHARS, validateSrtFile } from '@/lib/subtitles/validate'
import { DISCOVERY_EMPTY_AFTER_MS, discoveryState } from '@/lib/net/discovery'

const link = encodeJoinUrl({ v: PROTOCOL_VERSION, host: '192.168.43.1', wsPort: 8765, httpPort: 8766, sessionId: 'abcDEF123456', token: 'tok_tok_tok_tok' })

describe('invite links', () => {
  it('accepts a valid link and exposes the host', () => {
    const inv = parseInvite(link)
    expect(inv?.host).toBe('192.168.43.1')
    expect(inv?.url).toBe(link)
  })

  it('finds a link inside a pasted chat message', () => {
    expect(findInviteUrl(`hey join me! ${link} see you`)).toBe(link)
    expect(parseInvite(`hey join me! ${link} see you`)?.payload.httpPort).toBe(8766)
  })

  it('rejects malformed, wrong-version and foreign links', () => {
    expect(parseInvite(null)).toBeNull()
    expect(parseInvite('')).toBeNull()
    expect(parseInvite('https://example.com/join')).toBeNull()
    expect(parseInvite('railreel://join?v=1')).toBeNull()
    expect(parseInvite(link.replace(`v=${PROTOCOL_VERSION}`, 'v=999'))).toBeNull()
    expect(parseInvite('railreel://other?x=1')).toBeNull()
  })

  it('tells an other-version invite apart from a broken one', () => {
    const v1 = link.replace(`v=${PROTOCOL_VERSION}`, 'v=1')
    expect(isOtherVersionInvite(v1)).toBe(true)
    expect(isOtherVersionInvite(`join me: ${v1}`)).toBe(true)
    expect(isOtherVersionInvite(link)).toBe(false) // valid
    expect(isOtherVersionInvite('railreel://join?v=2')).toBe(false) // same version, just broken
    expect(isOtherVersionInvite('hello')).toBe(false)
  })
})

describe('guest name', () => {
  it('rejects empty and whitespace-only names (the host drops them silently)', () => {
    expect(isValidGuestName('')).toBe(false)
    expect(isValidGuestName('   \n ')).toBe(false)
    expect(isValidGuestName(' Riya ')).toBe(true)
  })

  it('trims, collapses whitespace and caps the length', () => {
    expect(normalizeGuestName('  Riya   Sharma ')).toBe('Riya Sharma')
    const long = normalizeGuestName('x'.repeat(100))
    expect(long.length).toBe(MAX_GUEST_NAME_LENGTH)
  })

  it('does not split a surrogate pair at the cap', () => {
    const name = normalizeGuestName('a'.repeat(MAX_GUEST_NAME_LENGTH - 1) + '😀😀')
    expect(Array.from(name).length).toBe(MAX_GUEST_NAME_LENGTH)
    expect(name.endsWith('😀')).toBe(true)
  })
})

describe('subtitle validation', () => {
  const good = '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral Kenobi\n'

  it('accepts a real srt and counts cues', () => {
    expect(validateSrtFile('movie.srt', good)).toEqual({ ok: true, cueCount: 2 })
    expect(validateSrtFile('MOVIE.SRT', good).ok).toBe(true)
  })

  it('rejects empty, zero-cue, wrong-extension and oversized files', () => {
    expect(validateSrtFile('a.srt', '')).toMatchObject({ ok: false, reason: 'empty' })
    expect(validateSrtFile('a.srt', '   \n\n')).toMatchObject({ ok: false, reason: 'empty' })
    expect(validateSrtFile('a.srt', 'this is not a subtitle file at all')).toMatchObject({ ok: false, reason: 'no-cues' })
    expect(validateSrtFile('a.txt', good)).toMatchObject({ ok: false, reason: 'not-srt' })
    expect(validateSrtFile('a.srt', good + 'x'.repeat(MAX_SRT_CHARS))).toMatchObject({ ok: false, reason: 'too-large' })
  })
})

describe('discoveryState', () => {
  it('scans during the grace period, then reports empty', () => {
    expect(discoveryState({ cabinCount: 0, startFailed: false, elapsedMs: 0 })).toBe('scanning')
    expect(discoveryState({ cabinCount: 0, startFailed: false, elapsedMs: DISCOVERY_EMPTY_AFTER_MS - 1 })).toBe('scanning')
    expect(discoveryState({ cabinCount: 0, startFailed: false, elapsedMs: DISCOVERY_EMPTY_AFTER_MS })).toBe('empty')
  })

  it('a failed start is not endless scanning', () => {
    expect(discoveryState({ cabinCount: 0, startFailed: true, elapsedMs: 0 })).toBe('failed')
  })

  it('found cabins win over everything else', () => {
    expect(discoveryState({ cabinCount: 1, startFailed: true, elapsedMs: 99999 })).toBe('found')
  })
})
