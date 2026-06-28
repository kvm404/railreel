import { describe, it, expect } from 'vitest'
import { decideCorrection, targetPositionSec } from '@/lib/sync/playback'
import type { PlaybackState } from '@/lib/protocol'

const state = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  positionSec: 100,
  rate: 1,
  isPlaying: true,
  hostMonotonicMs: 10_000,
  ...over,
})

describe('targetPositionSec', () => {
  it('advances by wall time while playing', () => {
    // 2s after the stamp → 100 + 2 = 102
    expect(targetPositionSec(state(), 12_000)).toBeCloseTo(102, 6)
  })

  it('scales by rate', () => {
    expect(targetPositionSec(state({ rate: 2 }), 12_000)).toBeCloseTo(104, 6)
  })

  it('is frozen when paused', () => {
    expect(targetPositionSec(state({ isPlaying: false }), 99_999)).toBe(100)
  })
})

describe('decideCorrection', () => {
  it('pauses and holds position when off while paused', () => {
    expect(decideCorrection({ targetSec: 100, actualSec: 105, isPlaying: false })).toEqual({
      action: 'pause',
      seekToSec: 100,
    })
  })

  it('pauses without a seek when already at position', () => {
    expect(decideCorrection({ targetSec: 100, actualSec: 100.01, isPlaying: false })).toEqual({
      action: 'pause',
      seekToSec: undefined,
    })
  })

  it('hard-seeks when drift exceeds the threshold', () => {
    const c = decideCorrection({ targetSec: 110, actualSec: 100, isPlaying: true })
    expect(c).toEqual({ action: 'play', rate: 1, seekToSec: 110 })
  })

  it('plays at normal rate inside the deadband', () => {
    expect(decideCorrection({ targetSec: 100.02, actualSec: 100, isPlaying: true })).toEqual({
      action: 'play',
      rate: 1,
    })
  })

  it('nudges rate up when slightly behind', () => {
    const c = decideCorrection({ targetSec: 100.4, actualSec: 100, isPlaying: true })
    expect(c.action).toBe('play')
    if (c.action === 'play') {
      expect(c.rate).toBeGreaterThan(1)
      expect(c.rate).toBeLessThanOrEqual(1.1)
      expect(c.seekToSec).toBeUndefined()
    }
  })

  it('nudges rate down when slightly ahead', () => {
    const c = decideCorrection({ targetSec: 100, actualSec: 100.4, isPlaying: true })
    if (c.action === 'play') {
      expect(c.rate).toBeLessThan(1)
      expect(c.rate).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('clamps the rate nudge to ±maxRateNudge', () => {
    const c = decideCorrection({ targetSec: 100.9, actualSec: 100, isPlaying: true }) // big-ish but < seek threshold
    if (c.action === 'play') expect(c.rate).toBeLessThanOrEqual(1.1)
  })

  describe('with a non-1 host rate (baseRate)', () => {
    it('holds the host rate inside the deadband', () => {
      expect(decideCorrection({ targetSec: 100.02, actualSec: 100, isPlaying: true, baseRate: 1.5 })).toEqual({
        action: 'play',
        rate: 1.5,
      })
    })

    it('resumes at the host rate after a hard seek', () => {
      expect(decideCorrection({ targetSec: 110, actualSec: 100, isPlaying: true, baseRate: 1.5 })).toEqual({
        action: 'play',
        rate: 1.5,
        seekToSec: 110,
      })
    })

    it('centers the nudge on the host rate, clamped to base ± maxRateNudge', () => {
      const c = decideCorrection({ targetSec: 100.4, actualSec: 100, isPlaying: true, baseRate: 1.5 })
      if (c.action === 'play') {
        expect(c.rate).toBeGreaterThan(1.5)
        expect(c.rate).toBeLessThanOrEqual(1.6)
      }
    })
  })
})
