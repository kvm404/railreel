import { describe, it, expect } from 'vitest'
import { captionLineBudget, sameActiveCues } from '@/lib/player/captions'
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

describe('captionLineBudget', () => {
  const sum = (b: number[][]) => b.flat().reduce((a, n) => a + n, 0)

  it('leaves captions alone without a cap', () => {
    expect(captionLineBudget([2], undefined)).toBeNull()
  })

  it('gives every line one row first, then lets them wrap', () => {
    expect(captionLineBudget([2], 2)).toEqual([[1, 1]])
    expect(captionLineBudget([2], 3)).toEqual([[2, 1]])
    expect(captionLineBudget([1], 3)).toEqual([[3]])
  })

  it('drops the lines that do not fit, from the bottom of the cue', () => {
    expect(captionLineBudget([3], 1)).toEqual([[1, 0, 0]])
  })

  it('charges extra plates a line and keeps the newest cue when both cannot fit', () => {
    expect(captionLineBudget([2, 1], 1)).toEqual([[0, 0], [1]])
    expect(captionLineBudget([1, 1], 3)).toEqual([[1], [1]])
  })

  it('never renders more than the budget', () => {
    for (const cues of [[1], [3], [2, 2], [1, 2, 1]]) {
      for (let m = 1; m <= 6; m++) {
        const b = captionLineBudget(cues, m)!
        const plates = b.filter((c) => c.some((n) => n > 0)).length
        expect(sum(b) + Math.max(0, plates - 1)).toBeLessThanOrEqual(m)
      }
    }
  })
})
