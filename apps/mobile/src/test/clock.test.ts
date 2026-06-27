import { describe, it, expect } from 'vitest'
import {
  estimateFromSample,
  bestEstimate,
  toHostTime,
  decideDriftCorrection,
  DEFAULT_DRIFT_THRESHOLDS,
} from '@/lib/sync/clock'

describe('clock offset estimation', () => {
  it('recovers a known offset with symmetric latency', () => {
    // Host clock is +1000ms ahead of client. One-way latency 50ms each way.
    // client sends at t1=0 -> arrives host at 50 client-time = 1050 host-time (t2)
    // host replies at t3=1050, arrives client at t4=100
    const e = estimateFromSample({ t1: 0, t2: 1050, t3: 1050, t4: 100 })
    expect(e.offsetMs).toBeCloseTo(1000, 6)
    expect(e.rttMs).toBeCloseTo(100, 6)
  })

  it('picks the lowest-RTT sample as most trustworthy', () => {
    const best = bestEstimate([
      { t1: 0, t2: 1200, t3: 1200, t4: 400 }, // rtt 400
      { t1: 0, t2: 1050, t3: 1050, t4: 100 }, // rtt 100 (best)
      { t1: 0, t2: 1100, t3: 1100, t4: 200 }, // rtt 200
    ])
    expect(best).not.toBeNull()
    expect(best!.rttMs).toBeCloseTo(100, 6)
    expect(best!.offsetMs).toBeCloseTo(1000, 6)
  })

  it('returns null for no samples', () => {
    expect(bestEstimate([])).toBeNull()
  })

  it('converts client time to host time', () => {
    expect(toHostTime(5000, 1000)).toBe(6000)
  })
})

describe('drift correction', () => {
  const T = DEFAULT_DRIFT_THRESHOLDS

  it('holds when within tolerance', () => {
    expect(decideDriftCorrection(10.0, 10.02).action).toBe('hold')
  })

  it('nudges faster when local is behind', () => {
    const d = decideDriftCorrection(10.1, 10.0) // 100ms behind
    expect(d.action).toBe('nudge')
    expect(d.rate).toBeCloseTo(1 + T.nudgeRate, 6)
  })

  it('nudges slower when local is ahead', () => {
    const d = decideDriftCorrection(10.0, 10.1) // 100ms ahead
    expect(d.action).toBe('nudge')
    expect(d.rate).toBeCloseTo(1 - T.nudgeRate, 6)
  })

  it('hard-seeks when drift is large', () => {
    expect(decideDriftCorrection(15.0, 10.0).action).toBe('seek')
  })
})
