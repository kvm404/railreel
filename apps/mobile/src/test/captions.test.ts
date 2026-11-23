import { describe, it, expect } from 'vitest'
import { sameActiveCues } from '@/lib/player/captions'
import { findActiveCues, type SubtitleCue } from '@/lib/subtitles'

const cue = (id: number, text: string, startMs: number, endMs: number): SubtitleCue => ({
  id,
  startMs,
  endMs,
  startSec: startMs / 1000,
  endSec: endMs / 1000,
  text,
  rawText: text,
  lines: [{ text, spans: [{ text }] }],
})

describe('sameActiveCues', () => {
  const v1 = [cue(41, 'old forty-one', 0, 1000), cue(42, 'old forty-two', 1000, 5000)]
  const v2 = [cue(41, 'new forty-one', 0, 1000), cue(42, 'new forty-two', 1000, 5000)]

  it('keeps the set across playhead ticks within one subtitle file', () => {
    expect(sameActiveCues(findActiveCues(v1, 1500), findActiveCues(v1, 2500))).toBe(true)
  })

  it('swaps to a replacement file even when the active cue id is the same (paused on cue 42)', () => {
    const before = findActiveCues(v1, 2000)
    const after = findActiveCues(v2, 2000)
    expect(before.map((c) => c.id)).toEqual(after.map((c) => c.id))
    expect(sameActiveCues(before, after)).toBe(false)
  })

  it('notices a cue entering or leaving', () => {
    expect(sameActiveCues([], findActiveCues(v1, 2000))).toBe(false)
    expect(sameActiveCues(findActiveCues(v1, 2000), [])).toBe(false)
    expect(sameActiveCues([], [])).toBe(true)
  })
})
