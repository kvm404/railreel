import { describe, it, expect } from 'vitest'
import { boardPhase, bucketRoster, createMilestoneLatch, ignitionSchedule, MAX_START_DELAY_MS } from '@/lib/sync/readiness'

const p = (id: string, status: string, progress = 0) => ({ id, status, progress })

describe('bucketRoster', () => {
  const people = [p('host', 'ready', 1), p('a', 'ready', 1), p('b', 'downloading', 0.4), p('c', 'requested'), p('d', 'left')]
  const b = bucketRoster(people)

  it('keeps wants-in, boarding and ready distinct', () => {
    expect(b.wantsIn.map((x) => x.id)).toEqual(['c'])
    expect(b.boarding.map((x) => x.id)).toEqual(['b'])
    expect(b.ready.map((x) => x.id)).toEqual(['host', 'a'])
  })

  it('counts aboard totals from the eligible roster (no requested/left)', () => {
    expect(b.eligible.map((x) => x.id)).toEqual(['host', 'a', 'b'])
  })

  it('feeds the start gate the same eligible set, minus the host', () => {
    expect(b.gateRoster.map((x) => x.id)).toEqual(['a', 'b'])
  })
})

describe('boardPhase', () => {
  const full = bucketRoster([p('host', 'ready', 1), p('a', 'ready', 1)])
  const mixed = bucketRoster([p('host', 'ready', 1), p('a', 'ready', 1), p('b', 'downloading', 0.2)])
  const alone = bucketRoster([p('host', 'ready', 1)])

  it('a still-requested guest never sees readiness', () => {
    // From a requested guest's view the roster can look fully ready (only the host is aboard).
    expect(boardPhase({ iAmRequested: true, buckets: full, gateStart: true })).toBe('awaiting-approval')
    expect(boardPhase({ iAmRequested: true, buckets: alone, gateStart: true })).toBe('awaiting-approval')
  })

  it('all-aboard only when nobody is still boarding', () => {
    expect(boardPhase({ iAmRequested: false, buckets: full, gateStart: true })).toBe('all-aboard')
    expect(boardPhase({ iAmRequested: false, buckets: mixed, gateStart: true })).toBe('ready-to-depart')
  })

  it('a closed gate is boarding; an empty cabin is solo', () => {
    expect(boardPhase({ iAmRequested: false, buckets: mixed, gateStart: false })).toBe('boarding')
    expect(boardPhase({ iAmRequested: false, buckets: alone, gateStart: true })).toBe('solo')
  })
})

describe('ignitionSchedule', () => {
  it('orders rows, then board, then bloom, then start', () => {
    const s = ignitionSchedule(4, false)
    expect(s.rowDelaysMs).toEqual([0, 140, 280, 420])
    expect(s.boardMs).toBeGreaterThan(s.rowDelaysMs[3]!)
    expect(s.bloomMs).toBeGreaterThan(s.boardMs)
    expect(s.startMs).toBeGreaterThan(s.bloomMs)
  })

  it('never holds the host longer than the cap, however many rows ignite', () => {
    for (let rows = 0; rows <= 12; rows++) {
      const s = ignitionSchedule(rows, false)
      expect(s.startMs).toBeLessThanOrEqual(MAX_START_DELAY_MS)
      expect(s.bloomMs).toBeGreaterThan(s.boardMs)
      expect(s.startMs).toBeGreaterThan(s.bloomMs)
      s.rowDelaysMs.forEach((d, i) => i > 0 && expect(d).toBeGreaterThanOrEqual(s.rowDelaysMs[i - 1]!))
    }
    // The six-person cabin keeps its full beat close to the original pacing.
    expect(ignitionSchedule(6, false).startMs).toBeGreaterThan(1300)
  })

  it('collapses to an instant, still-ordered state under reduce-motion', () => {
    const s = ignitionSchedule(3, true)
    expect(s).toEqual({ rowDelaysMs: [0, 0, 0], boardMs: 0, bloomMs: 0, startMs: 0 })
  })

  it('handles an empty roster', () => {
    expect(ignitionSchedule(0, false).rowDelaysMs).toEqual([])
  })
})

describe('createMilestoneLatch', () => {
  it('fires a key once until reset', () => {
    const l = createMilestoneLatch()
    expect(l.has('ready')).toBe(false)
    expect(l.claim('ready')).toBe(true)
    expect(l.has('ready')).toBe(true)
    expect(l.claim('ready')).toBe(false)
    expect(l.claim('other')).toBe(true)
    l.reset()
    expect(l.claim('ready')).toBe(true)
  })
})
