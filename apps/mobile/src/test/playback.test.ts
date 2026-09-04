import { describe, it, expect } from 'vitest'
import { decideCorrection, nextSeekLead, roomGate, stallReport, targetPositionSec } from '@/lib/sync/playback'
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

  it('never returns negative even when hostNowMs is slightly behind hostMonotonicMs', () => {
    expect(targetPositionSec(state({ positionSec: 0 }), 9_950)).toBe(0)
  })

  it('handles NaN or non-finite position or timestamp safely', () => {
    expect(targetPositionSec(state({ positionSec: NaN }), 10_000)).toBe(0)
    expect(targetPositionSec(state({ positionSec: NaN }), 12_000)).toBe(2)
    expect(targetPositionSec(state(), NaN)).toBe(100)
    expect(targetPositionSec(state({ hostMonotonicMs: NaN }), 12_000)).toBe(100)
    expect(targetPositionSec(state({ isPlaying: false, positionSec: NaN }), 12_000)).toBe(0)
  })
})

describe('decideCorrection', () => {
  it('clamps seekToSec to >= 0 when target is negative', () => {
    const c = decideCorrection({ targetSec: -0.5, actualSec: 10, isPlaying: true })
    expect(c.seekToSec).toBe(0)
    const cPause = decideCorrection({ targetSec: -0.5, actualSec: 10, isPlaying: false })
    expect(cPause.seekToSec).toBe(0)
  })

  it('handles NaN or non-finite positions without throwing or producing NaN rate', () => {
    const c = decideCorrection({ targetSec: NaN, actualSec: NaN, isPlaying: true })
    expect(c.action).toBe('play')
    if (c.action === 'play') {
      expect(Number.isFinite(c.rate)).toBe(true)
    }
  })

  it('handles NaN seekLeadSec and NaN baseRate safely', () => {
    const cHard = decideCorrection({ targetSec: 120, actualSec: 100, isPlaying: true, seekLeadSec: NaN, baseRate: NaN })
    expect(cHard.action).toBe('play')
    if (cHard.action === 'play') {
      expect(cHard.seekToSec).toBe(120)
      expect(Number.isFinite(cHard.seekToSec)).toBe(true)
      expect(cHard.rate).toBe(1)
    }

    const cNudge = decideCorrection({ targetSec: 100.3, actualSec: 100, isPlaying: true, baseRate: NaN })
    expect(cNudge.action).toBe('play')
    if (cNudge.action === 'play') {
      expect(Number.isFinite(cNudge.rate)).toBe(true)
      expect(cNudge.rate).toBeGreaterThan(1)
    }
  })

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

  it('nudges rate up when slightly behind (inaudible near-band cap)', () => {
    const c = decideCorrection({ targetSec: 100.4, actualSec: 100, isPlaying: true })
    expect(c.action).toBe('play')
    if (c.action === 'play') {
      expect(c.rate).toBeGreaterThan(1)
      expect(c.rate).toBeLessThanOrEqual(1.05)
      expect(c.seekToSec).toBeUndefined()
    }
  })

  it('nudges rate down when slightly ahead', () => {
    const c = decideCorrection({ targetSec: 100, actualSec: 100.4, isPlaying: true })
    if (c.action === 'play') {
      expect(c.rate).toBeLessThan(1)
      expect(c.rate).toBeGreaterThanOrEqual(0.95)
    }
  })

  // Smoothness guardrails: imperceptible drift is ignored, and a sub-threshold gap is nudged
  // (not seeked) so playback never re-buffers / drops audio for small corrections.
  it('leaves sub-deadband drift completely alone (exactly base rate, no seek)', () => {
    expect(decideCorrection({ targetSec: 100.1, actualSec: 100, isPlaying: true })).toEqual({
      action: 'play',
      rate: 1,
    })
  })

  it('escalates to the assertive catch-up cap beyond the near band — still no seek', () => {
    const c = decideCorrection({ targetSec: 100.9, actualSec: 100, isPlaying: true }) // 0.9s behind
    expect(c.action).toBe('play')
    if (c.action === 'play') {
      expect(c.seekToSec).toBeUndefined()
      expect(c.rate).toBeGreaterThan(1.05) // past the inaudible cap…
      expect(c.rate).toBeLessThanOrEqual(1.15) // …but bounded by the far cap
    }
  })

  it('the two nudge stages meet at the near-band edge', () => {
    const near = decideCorrection({ targetSec: 100.5, actualSec: 100, isPlaying: true })
    const far = decideCorrection({ targetSec: 100.51, actualSec: 100, isPlaying: true })
    if (near.action === 'play') expect(near.rate).toBeLessThanOrEqual(1.05)
    if (far.action === 'play') expect(far.rate).toBeGreaterThan(1.05)
  })

  it('hard-seeks once the gap exceeds the seek threshold', () => {
    const c = decideCorrection({ targetSec: 101.3, actualSec: 100, isPlaying: true })
    expect(c.action === 'play' && c.seekToSec).toBe(101.3)
  })

  describe('seek lead (landing-latency compensation)', () => {
    it('leads a forward seek by the measured landing latency', () => {
      const c = decideCorrection({ targetSec: 110, actualSec: 100, isPlaying: true, seekLeadSec: 0.8 })
      expect(c.action === 'play' && c.seekToSec).toBeCloseTo(110.8)
    })

    it('never leads a backwards seek (ahead of host) past the target', () => {
      const c = decideCorrection({ targetSec: 100, actualSec: 110, isPlaying: true, seekLeadSec: 0.8 })
      expect(c.action === 'play' && c.seekToSec).toBe(100)
    })

    it('does not lead while paused (the target is not moving)', () => {
      const c = decideCorrection({ targetSec: 100, actualSec: 105, isPlaying: false, seekLeadSec: 0.8 })
      expect(c.action === 'pause' && c.seekToSec).toBe(100)
    })
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
        expect(c.rate).toBeLessThanOrEqual(1.55)
      }
    })
  })
})

describe('nextSeekLead', () => {
  it('adopts the first believable sample directly', () => {
    expect(nextSeekLead(0, 0.6)).toBe(0.6)
  })

  it('smooths later samples instead of jumping', () => {
    const next = nextSeekLead(0.6, 1.2)
    expect(next).toBeGreaterThan(0.6)
    expect(next).toBeLessThan(1.2)
  })

  it('rejects implausible samples (timer noise, mid-seek rebuffers)', () => {
    expect(nextSeekLead(0.6, 0.01)).toBe(0.6)
    expect(nextSeekLead(0.6, 30)).toBe(0.6)
    expect(nextSeekLead(0.6, NaN)).toBe(0.6)
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
