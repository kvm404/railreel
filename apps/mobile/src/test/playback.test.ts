import { describe, it, expect } from 'vitest'
import { decideCorrection, roomGate, stallReport, targetPositionSec } from '@/lib/sync/playback'
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

  // Smoothness guardrails: imperceptible drift is ignored, and a sub-1.5s gap is nudged (not seeked)
  // so playback never re-buffers / drops audio for small corrections.
  it('leaves sub-deadband drift completely alone (exactly base rate, no seek)', () => {
    expect(decideCorrection({ targetSec: 100.2, actualSec: 100, isPlaying: true })).toEqual({
      action: 'play',
      rate: 1,
    })
  })

  it('nudges (never seeks) for a moderate gap under the seek threshold', () => {
    const c = decideCorrection({ targetSec: 101.2, actualSec: 100, isPlaying: true }) // 1.2s behind
    expect(c.action).toBe('play')
    if (c.action === 'play') {
      expect(c.seekToSec).toBeUndefined()
      expect(c.rate).toBeGreaterThan(1)
      expect(c.rate).toBeLessThanOrEqual(1.06)
    }
  })

  it('hard-seeks only once the gap exceeds 1.5s', () => {
    const c = decideCorrection({ targetSec: 101.6, actualSec: 100, isPlaying: true })
    expect(c.action === 'play' && c.seekToSec).toBe(101.6)
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

describe('roomGate', () => {
  it('pauses the room when a straggler appears while playing', () => {
    expect(roomGate({ autoPaused: false, playing: true }, true)).toBe('pause')
  })

  it('does nothing if already paused while blocked', () => {
    expect(roomGate({ autoPaused: true, playing: false }, true)).toBe('none')
  })

  it('resumes once everyone has caught up (only what it auto-paused)', () => {
    expect(roomGate({ autoPaused: true, playing: false }, false)).toBe('resume')
  })

  it('does not fight a manual pause (auto-paused false → no resume)', () => {
    expect(roomGate({ autoPaused: false, playing: false }, false)).toBe('none')
  })

  it('does nothing while playing and unblocked', () => {
    expect(roomGate({ autoPaused: false, playing: true }, false)).toBe('none')
  })
})

describe('stallReport', () => {
  const GRACE = 1200

  it('is never stalled while the player is ready (and clears the timer)', () => {
    expect(stallReport(false, 5000, 9999)).toEqual({ notReadySince: null, stalled: false })
  })

  it('starts the timer but does not stall on the first not-ready tick', () => {
    expect(stallReport(true, null, 1000)).toEqual({ notReadySince: 1000, stalled: false })
  })

  it('does not stall for a brief not-ready blip (a drift-seek)', () => {
    // went not-ready at 1000, still well within grace at 1500 → no stall
    expect(stallReport(true, 1000, 1500)).toEqual({ notReadySince: 1000, stalled: false })
  })

  it('stalls once not-ready has persisted past the grace window', () => {
    expect(stallReport(true, 1000, 1000 + GRACE)).toEqual({ notReadySince: 1000, stalled: true })
  })

  it('clears immediately when the player becomes ready again', () => {
    // even after a real stall, the very next ready tick reports not-stalled
    expect(stallReport(false, 1000, 1000 + GRACE + 500)).toEqual({ notReadySince: null, stalled: false })
  })

  it('honors a custom grace window', () => {
    expect(stallReport(true, 1000, 1300, 200).stalled).toBe(true)
    expect(stallReport(true, 1000, 1100, 200).stalled).toBe(false)
  })
})
