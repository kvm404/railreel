import { describe, it, expect } from 'vitest'
import {
  canJoinShow,
  departureClock,
  decideStartGate,
  downloadBufferedAheadSec,
  secondsToFinish,
  smoothedMbps,
  updateFloorHolds,
  type GateClient,
  type GateMedia,
} from '@/lib/sync/startGate'

// A 2h movie at ~3.3 Mbps ≈ 3 GB — the PRD's "train trip" case (2–3 GB, 1080p, small group).
const MOVIE: GateMedia = { sizeBytes: 3_000_000_000, durationSec: 7200 }

const client = (over: Partial<GateClient> = {}): GateClient => ({
  id: 'c1',
  name: 'Asha',
  progress: 0.05,
  downloadMbps: 12,
  positionSec: 0,
  ...over,
})

describe('downloadBufferedAheadSec', () => {
  it('maps progress to seconds of media ahead of the playhead', () => {
    expect(downloadBufferedAheadSec(0.5, 7200, 0)).toBe(3600)
    expect(downloadBufferedAheadSec(0.5, 7200, 3000)).toBe(600)
  })

  it('never goes negative and clamps progress', () => {
    expect(downloadBufferedAheadSec(0.1, 7200, 6000)).toBe(0)
    expect(downloadBufferedAheadSec(1.4, 7200, 0)).toBe(7200)
    expect(downloadBufferedAheadSec(-1, 7200, 0)).toBe(0)
  })

  it('handles NaN or non-finite inputs safely', () => {
    expect(downloadBufferedAheadSec(NaN, 7200, 0)).toBe(0)
    expect(downloadBufferedAheadSec(0.5, NaN, 0)).toBe(0)
    expect(downloadBufferedAheadSec(0.5, 7200, NaN)).toBe(3600)
    expect(downloadBufferedAheadSec(NaN, NaN, NaN)).toBe(0)
  })
})

describe('secondsToFinish', () => {
  it('is 0 for a finished client and Infinity when the rate is unknown', () => {
    expect(secondsToFinish(client({ progress: 1 }), MOVIE)).toBe(0)
    expect(secondsToFinish(client({ downloadMbps: 0 }), MOVIE)).toBe(Infinity)
  })

  it('computes remaining bytes over the measured rate', () => {
    // half of 3GB left at 12 Mbps → 12e9 bits / 12e6 bps = 1000s
    expect(secondsToFinish(client({ progress: 0.5, downloadMbps: 12 }), MOVIE)).toBeCloseTo(1000)
  })

  it('handles NaN progress, downloadMbps, and media size safely', () => {
    expect(secondsToFinish(client({ progress: NaN }), MOVIE)).toBeGreaterThan(0)
    expect(secondsToFinish(client({ downloadMbps: NaN }), MOVIE)).toBe(Infinity)
    expect(secondsToFinish(client({ progress: 0.5, downloadMbps: 12 }), { sizeBytes: NaN, durationSec: 7200 })).toBe(0)
  })
})

describe('decideStartGate', () => {
  it('starts immediately when everyone has finished (the pre-cache endgame)', () => {
    const d = decideStartGate([client({ progress: 1 }), client({ id: 'c2', name: 'Ben', progress: 1 })], MOVIE)
    expect(d).toEqual({ start: true, mode: 'progressive', etaSec: null, waitingOn: [] })
  })

  it('starts with an empty room (host alone)', () => {
    expect(decideStartGate([], MOVIE).start).toBe(true)
  })

  it('opens progressively once a fast client has the start buffer', () => {
    // 2% of 2h = 144s buffered; 12 Mbps beats the 3.3 Mbps bitrate ~4× over
    const d = decideStartGate([client({ progress: 0.02, downloadMbps: 12 })], MOVIE)
    expect(d.start).toBe(true)
    expect(d.mode).toBe('progressive')
  })

  it('waits (progressive) while the start buffer is still filling, with a short ETA', () => {
    // 0.5% = 36s buffered < 60s, but throughput is fine → progressive wait, ETA is seconds not minutes
    const d = decideStartGate([client({ progress: 0.005, downloadMbps: 12 })], MOVIE)
    expect(d.start).toBe(false)
    expect(d.mode).toBe('progressive')
    expect(d.waitingOn).toEqual(['Asha'])
    expect(d.etaSec).toBeGreaterThan(0)
    expect(d.etaSec!).toBeLessThan(60) // filling ~24s of media at 4× realtime
  })

  it('falls back to precache when throughput cannot outrun playback', () => {
    // 3 Mbps < 3.33 Mbps bitrate → the download loses the race; only a full pre-cache is safe
    const d = decideStartGate([client({ progress: 0.02, downloadMbps: 3 })], MOVIE)
    expect(d.start).toBe(false)
    expect(d.mode).toBe('precache')
    expect(d.etaSec).toBeGreaterThan(3600) // ~2.2h of remaining bytes at 3 Mbps
  })

  it('treats an unknown rate as not-provably-safe (precache, no ETA)', () => {
    const d = decideStartGate([client({ downloadMbps: 0 })], MOVIE)
    expect(d.start).toBe(false)
    expect(d.mode).toBe('precache')
    expect(d.etaSec).toBeNull()
  })

  it('one slow client gates the whole room, and is named', () => {
    const fast = client({ progress: 0.1, downloadMbps: 12 })
    const slow = client({ id: 'c2', name: 'Ben', progress: 0.02, downloadMbps: 2 })
    const d = decideStartGate([fast, slow], MOVIE)
    expect(d.start).toBe(false)
    expect(d.waitingOn).toEqual(['Ben'])
  })

  it('exactly-bitrate throughput with a real head start holds the gap — allowed to start', () => {
    // 2% (144s) buffered, downloading at exactly 1× bitrate: the buffer never shrinks, and the
    // 144s head start clears the 60s margin → progressive start is safe.
    const bitrateMbps = (MOVIE.sizeBytes * 8) / MOVIE.durationSec / 1e6
    expect(decideStartGate([client({ progress: 0.02, downloadMbps: bitrateMbps })], MOVIE).start).toBe(true)
  })

  it('respects the margin: slightly-under-bitrate throughput forces precache', () => {
    // At 0.95× bitrate the playhead slowly eats the buffer; finish lands past remainingPlay − margin
    const bitrateMbps = (MOVIE.sizeBytes * 8) / MOVIE.durationSec / 1e6
    const d = decideStartGate([client({ progress: 0.02, downloadMbps: bitrateMbps * 0.95 })], MOVIE)
    expect(d.start).toBe(false)
    expect(d.mode).toBe('precache')
  })

  it('a file that cannot be played partially (precacheOnly) always waits for full downloads', () => {
    // Great buffer + throughput, but moov-at-end: a partial file can't even open → precache.
    const d = decideStartGate([client({ progress: 0.3, downloadMbps: 50 })], { ...MOVIE, precacheOnly: true })
    expect(d.start).toBe(false)
    expect(d.mode).toBe('precache')
    expect(d.etaSec).toBeGreaterThan(0) // rate is known → the pre-cache ETA still shows
    // …and it still starts once everyone has the whole file.
    expect(decideStartGate([client({ progress: 1 })], { ...MOVIE, precacheOnly: true }).start).toBe(true)
  })

  it('unknown media size or duration is not provably safe — precache, never an early green-light', () => {
    // A content:// picker can return no size: remainingBytes would be 0 and the naive math would
    // "prove" every download finishes instantly. The gate must refuse instead.
    const noSize = decideStartGate([client({ progress: 0.02, downloadMbps: 12 })], { sizeBytes: 0, durationSec: 7200 })
    expect(noSize.start).toBe(false)
    expect(noSize.mode).toBe('precache')
    expect(noSize.etaSec).toBeNull() // nothing meaningful to estimate

    const noDuration = decideStartGate([client({ progress: 0.02, downloadMbps: 12 })], { sizeBytes: 3e9, durationSec: 0 })
    expect(noDuration.start).toBe(false)
    expect(noDuration.mode).toBe('precache')
  })

  it('one unmeasurable client does not erase the finite ETA of the others', () => {
    const slow = client({ id: 'c1', name: 'Ben', progress: 0.02, downloadMbps: 3 }) // finite ~2.2h
    const unknown = client({ id: 'c2', name: 'Cara', downloadMbps: 0 })
    const d = decideStartGate([slow, unknown], MOVIE)
    expect(d.start).toBe(false)
    expect(d.waitingOn).toEqual(['Ben', 'Cara'])
    expect(d.etaSec).toBeGreaterThan(3600) // Ben's known estimate survives
  })

  it('honors custom thresholds', () => {
    const c = client({ progress: 0.005, downloadMbps: 12 }) // 36s buffered
    expect(decideStartGate([c], MOVIE, { minStartBufferSec: 30 }).start).toBe(true)
    expect(decideStartGate([c], MOVIE, { minStartBufferSec: 60 }).start).toBe(false)
  })

  it('excludes clients with status left from start gate decisions', () => {
    // A left client with 0% progress would normally block start gate (precache)
    const leftClient = client({ id: 'c-left', name: 'LeftGuest', progress: 0, downloadMbps: 0, status: 'left' })
    const readyClient = client({ id: 'c-ready', name: 'ReadyGuest', progress: 1, status: 'ready' })
    const d = decideStartGate([readyClient, leftClient], MOVIE)
    expect(d.start).toBe(true)
    expect(d.waitingOn).toEqual([])
  })

  it('excludes clients with status requested from start gate decisions', () => {
    // An unapproved requested guest with 0% progress must not block start gate
    const reqClient = client({ id: 'c-req', name: 'Stranger', progress: 0, downloadMbps: 0, status: 'requested' })
    const readyClient = client({ id: 'c-ready', name: 'ReadyGuest', progress: 1, status: 'ready' })
    const d = decideStartGate([readyClient, reqClient], MOVIE)
    expect(d.start).toBe(true)
    expect(d.waitingOn).toEqual([])
  })

  it('handles NaN positionSec and progress without crashing or forcing precache incorrectly', () => {
    const c = client({ progress: 0.5, downloadMbps: 50, positionSec: NaN })
    const d = decideStartGate([c], MOVIE)
    expect(d.start).toBe(true)
    expect(d.mode).toBe('progressive')
  })
})

describe('updateFloorHolds', () => {
  const floor = (progress: number, bufferedAheadSec: number, id = 'c1') => ({ id, progress, bufferedAheadSec })

  it('holds a downloading client under the floor', () => {
    expect(updateFloorHolds(new Set(), [floor(0.5, 10)])).toEqual(new Set(['c1']))
  })

  it('never holds a finished client', () => {
    expect(updateFloorHolds(new Set(), [floor(1, 0)])).toEqual(new Set())
  })

  it('does not hold a healthy client', () => {
    expect(updateFloorHolds(new Set(), [floor(0.5, 40)])).toEqual(new Set())
  })

  it('holds when bufferedAheadSec is NaN (fails safe)', () => {
    expect(updateFloorHolds(new Set(), [floor(0.5, NaN)])).toEqual(new Set(['c1']))
  })

  it('hysteresis: a held client stays held until it recovers past the release mark', () => {
    let held = updateFloorHolds(new Set(), [floor(0.5, 10)])
    // recovered above the floor (15) but below release (30) → still held, no flapping
    held = updateFloorHolds(held, [floor(0.5, 20)])
    expect(held).toEqual(new Set(['c1']))
    // past the release mark → free
    held = updateFloorHolds(held, [floor(0.5, 31)])
    expect(held).toEqual(new Set())
  })

  it('a client that finishes its download while held is released', () => {
    expect(updateFloorHolds(new Set(['c1']), [floor(1, 20)])).toEqual(new Set())
  })
})

describe('smoothedMbps', () => {
  it('measures a first sample directly', () => {
    // 1 MB in 1s = 8 Mbps
    expect(smoothedMbps(0, 1_000_000, 1000)).toBeCloseTo(8)
  })

  it('smooths toward a new rate instead of jumping', () => {
    const next = smoothedMbps(8, 2_000_000, 1000) // instant 16 Mbps
    expect(next).toBeGreaterThan(8)
    expect(next).toBeLessThan(16)
  })

  it('ignores windows too short to measure', () => {
    expect(smoothedMbps(8, 500_000, 100)).toBe(8)
  })

  it('handles NaN or non-finite inputs without producing NaN', () => {
    expect(smoothedMbps(8, NaN, 1000)).toBe(8)
    expect(smoothedMbps(8, 1_000_000, NaN)).toBe(8)
    expect(smoothedMbps(NaN, 1_000_000, 1000)).toBeCloseTo(8)
  })
})

describe('canJoinShow', () => {
  // 2h movie
  const DUR = 7200

  it('lets a finished download in immediately, wherever the playhead is', () => {
    expect(canJoinShow(1, DUR, 6000)).toBe(true)
  })

  it('lets a late joiner in once its buffer covers the playhead plus the lead', () => {
    // 50% downloaded = 3600s cached; playhead at 3000s → 600s ahead ≥ 30s
    expect(canJoinShow(0.5, DUR, 3000)).toBe(true)
  })

  it('holds a late joiner back when its download edge is behind the playhead', () => {
    // 10% = 720s cached; playhead already at 700s → only 20s ahead < 30s lead
    expect(canJoinShow(0.1, DUR, 700)).toBe(false)
  })

  it('waits for the whole file when the duration is unknown', () => {
    expect(canJoinShow(0.9, 0, 0)).toBe(false)
    expect(canJoinShow(1, 0, 0)).toBe(true) // finished still trumps
  })
})

describe('departureClock', () => {
  it('formats seconds as M:SS with a padded seconds field', () => {
    expect(departureClock(252)).toBe('4:12')
    expect(departureClock(9)).toBe('0:09')
    expect(departureClock(60)).toBe('1:00')
  })

  it('shows dashes when the ETA is unknown', () => {
    expect(departureClock(null)).toBe('--:--')
    expect(departureClock(Infinity)).toBe('--:--')
  })

  it('floors at 0:00 and clamps a huge pre-cache ETA', () => {
    expect(departureClock(-5)).toBe('0:00')
    expect(departureClock(999_999)).toBe('99:59')
  })
})
