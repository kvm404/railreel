import { describe, it, expect } from 'vitest'
import { PROGRESS_PUBLISH_MS, rosterChange, shouldPublishProgress, type RosterRow } from '@/lib/net/telemetry'

describe('shouldPublishProgress', () => {
  it('throttles mid-transfer values to one per gap', () => {
    expect(shouldPublishProgress(0.31, 0.3, 1000, 1000 + PROGRESS_PUBLISH_MS - 1)).toBe(false)
    expect(shouldPublishProgress(0.31, 0.3, 1000, 1000 + PROGRESS_PUBLISH_MS)).toBe(true)
  })

  it('always publishes 0 (reset) and 1 (complete), and never repeats a value', () => {
    expect(shouldPublishProgress(0, 0.5, 1000, 1001)).toBe(true)
    expect(shouldPublishProgress(1, 0.99, 1000, 1001)).toBe(true)
    expect(shouldPublishProgress(0.5, 0.5, 0, 10_000)).toBe(false)
  })
})

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: 'g1',
  name: 'Asha',
  status: 'downloading',
  progress: 0.42,
  downloadMbps: 12.3,
  bufferedAheadSec: 40.2,
  stalled: false,
  inShow: false,
  decodeOk: true,
  ...over,
})

describe('rosterChange', () => {
  it('membership, status and room-holding flags are structural', () => {
    expect(rosterChange([row()], [row(), row({ id: 'g2' })])).toBe('structural')
    expect(rosterChange([row()], [row({ status: 'ready' })])).toBe('structural')
    expect(rosterChange([row()], [row({ stalled: true })])).toBe('structural')
    expect(rosterChange([row()], [row({ inShow: true })])).toBe('structural')
    expect(rosterChange([row()], [row({ decodeOk: false })])).toBe('structural')
    expect(rosterChange([row(), row({ id: 'g2' })], [row({ id: 'g2' }), row()])).toBe('structural')
  })

  it('visible numbers are telemetry', () => {
    expect(rosterChange([row()], [row({ progress: 0.43 })])).toBe('telemetry')
    expect(rosterChange([row()], [row({ downloadMbps: 12.5 })])).toBe('telemetry')
    expect(rosterChange([row()], [row({ bufferedAheadSec: 41.1 })])).toBe('telemetry')
  })

  it('invisible jitter (heartbeat stamps, sub-percent progress) is nothing', () => {
    const prev = [row()]
    expect(rosterChange(prev, prev)).toBe('none')
    expect(rosterChange(prev, [{ ...row(), lastBeatAt: 99 } as RosterRow])).toBe('none')
    expect(rosterChange(prev, [row({ progress: 0.4249, downloadMbps: 12.31, bufferedAheadSec: 40.9 })])).toBe('none')
    // The host row's infinite buffer never reads as a change.
    expect(rosterChange([row({ bufferedAheadSec: Infinity })], [row({ bufferedAheadSec: Infinity })])).toBe('none')
  })
})
