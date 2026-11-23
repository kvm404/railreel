import { describe, it, expect } from 'vitest'
import {
  isSubtitleMeta,
  needsSubtitleFetch,
  parseSubtitlePayload,
  recordSubtitlePull,
  SUBTITLE_PULL_MAX_TRIES,
  SUBTITLE_PULL_TIMEOUT_MS,
  SUBTITLE_MAX_BYTES,
  subtitleMeta,
  subtitleRev,
  utf8ByteLength,
} from '@/lib/protocol'

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello\n'

describe('utf8ByteLength', () => {
  it('counts real UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8ByteLength('')).toBe(0)
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('日本')).toBe(6)
    expect(utf8ByteLength('🎬')).toBe(4) // one surrogate pair, String#length is 2
    expect(utf8ByteLength('\ud83c')).toBe(3) // lone surrogate encodes as U+FFFD
  })

  it('agrees with TextEncoder on mixed text', () => {
    const s = 'Ça va? 你好 🍿 — "quotes"\n'
    expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length)
  })
})

describe('subtitleRev', () => {
  it('is stable for the same content', () => {
    expect(subtitleRev(SRT)).toBe(subtitleRev(SRT))
    expect(subtitleRev(SRT)).toMatch(/^s1:[0-9a-f]{8}-[0-9a-f]+$/)
  })

  it('changes when a same-name file is corrected', () => {
    const fixed = SRT.replace('Hello', 'Hullo')
    expect(subtitleRev(fixed)).not.toBe(subtitleRev(SRT))
    // Same name, different body → different meta rev (the reconnect-replacement case).
    expect(subtitleMeta('movie.srt', fixed).rev).not.toBe(subtitleMeta('movie.srt', SRT).rev)
  })
})

describe('subtitleMeta / isSubtitleMeta', () => {
  it('builds metadata without the body', () => {
    const m = subtitleMeta('movie.srt', 'é\n')
    expect(m).toEqual({ name: 'movie.srt', sizeBytes: 3, rev: subtitleRev('é\n') })
    expect(isSubtitleMeta(m)).toBe(true)
  })

  it('rejects malformed metadata', () => {
    expect(isSubtitleMeta(null)).toBe(false)
    expect(isSubtitleMeta({ name: 'a.srt', sizeBytes: 3 })).toBe(false) // no rev (legacy)
    expect(isSubtitleMeta({ name: '', sizeBytes: 3, rev: 'x' })).toBe(false)
    expect(isSubtitleMeta({ name: 'a.srt', sizeBytes: NaN, rev: 'x' })).toBe(false)
    expect(isSubtitleMeta({ name: 'a.srt', sizeBytes: 3, rev: 'x'.repeat(65) })).toBe(false)
    expect(isSubtitleMeta({ name: 'x'.repeat(121), sizeBytes: 3, rev: 'x' })).toBe(false)
  })
})

describe('parseSubtitlePayload', () => {
  it('loads a body and recomputes its revision (never trusts the frame)', () => {
    const p = parseSubtitlePayload({ t: 'subtitle', name: 'movie.srt', content: SRT, rev: 'forged' })
    expect(p).toEqual({ kind: 'load', name: 'movie.srt', content: SRT, rev: subtitleRev(SRT) })
  })

  it('treats empty name + content as a clear', () => {
    expect(parseSubtitlePayload({ t: 'subtitle', name: '', content: '' })).toEqual({ kind: 'clear' })
  })

  it('rejects half-empty, oversized, or malformed frames', () => {
    expect(parseSubtitlePayload({ t: 'subtitle', name: 'a.srt', content: '' })).toBeNull()
    expect(parseSubtitlePayload({ t: 'subtitle', name: '', content: SRT })).toBeNull()
    expect(parseSubtitlePayload({ t: 'subtitle', name: 'a.srt' })).toBeNull()
    expect(parseSubtitlePayload({ t: 'chat', name: 'a.srt', content: SRT })).toBeNull()
    expect(parseSubtitlePayload(null)).toBeNull()
    expect(parseSubtitlePayload({ t: 'subtitle', name: 'a.srt', content: 'x'.repeat(SUBTITLE_MAX_BYTES + 1) })).toBeNull()
  })
})

describe('needsSubtitleFetch', () => {
  const meta = subtitleMeta('movie.srt', SRT)

  const T0 = 1_000_000
  const asked = recordSubtitlePull(null, meta.rev, T0)

  it('fetches a revision we do not have', () => {
    expect(needsSubtitleFetch(null, meta, null, T0)).toBe(true)
    expect(needsSubtitleFetch('s1:old', meta, null, T0)).toBe(true)
  })

  it('does not refetch what we have, or what we just asked for', () => {
    expect(needsSubtitleFetch(meta.rev, meta, null, T0)).toBe(false)
    expect(needsSubtitleFetch(null, meta, asked, T0 + SUBTITLE_PULL_TIMEOUT_MS - 1)).toBe(false)
  })

  it('re-asks an unanswered pull after the timeout, a bounded number of times', () => {
    expect(needsSubtitleFetch(null, meta, asked, T0 + SUBTITLE_PULL_TIMEOUT_MS)).toBe(true)
    let pull = asked
    for (let i = 1; i < SUBTITLE_PULL_MAX_TRIES; i++) pull = recordSubtitlePull(pull, meta.rev, T0 + i)
    expect(pull.tries).toBe(SUBTITLE_PULL_MAX_TRIES)
    expect(needsSubtitleFetch(null, meta, pull, T0 + 999_999)).toBe(false)
  })

  it('asks again (fresh count) when the roster moves on to a newer revision', () => {
    const newer = subtitleMeta('movie.srt', SRT + 'x')
    expect(needsSubtitleFetch(null, newer, asked, T0)).toBe(true)
    expect(recordSubtitlePull(asked, newer.rev, T0)).toEqual({ rev: newer.rev, at: T0, tries: 1 })
  })

  it('nothing to fetch when the roster carries no subtitle', () => {
    expect(needsSubtitleFetch('s1:any', undefined, null, T0)).toBe(false)
    expect(needsSubtitleFetch(null, null, null, T0)).toBe(false)
  })
})
