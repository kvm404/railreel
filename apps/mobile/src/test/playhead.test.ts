import { describe, it, expect } from 'vitest'
import { createPlayheadStore } from '@/lib/player/playhead'

describe('createPlayheadStore', () => {
  it('notifies subscribers of new positions only', () => {
    const p = createPlayheadStore()
    const seen: number[] = []
    p.subscribe((s) => seen.push(s))
    p.ingest(1, 0)
    p.ingest(1, 100) // unchanged — no notification
    p.ingest(1.1, 200)
    expect(seen).toEqual([1, 1.1])
    expect(p.get()).toBe(1.1)
  })

  it('cleans non-finite and negative ticks to zero', () => {
    const p = createPlayheadStore(5)
    p.ingest(NaN, 0)
    expect(p.get()).toBe(0)
    p.ingest(-3, 0)
    expect(p.get()).toBe(0)
  })

  it('stops notifying after unsubscribe', () => {
    const p = createPlayheadStore()
    const seen: number[] = []
    const off = p.subscribe((s) => seen.push(s))
    off()
    p.ingest(3, 0)
    expect(seen).toEqual([])
  })

  it('holds a published seek against stale ticks from before it landed', () => {
    const p = createPlayheadStore()
    p.ingest(100, 0)
    p.publish(600, 1_000)
    p.ingest(100.1, 1_100) // the player has not landed yet — ignore
    expect(p.get()).toBe(600)
    p.ingest(600.2, 1_300) // landed — accepted and the hold is released
    expect(p.get()).toBe(600.2)
    p.ingest(601, 1_400)
    expect(p.get()).toBe(601)
  })

  it('gives up the hold after its window so a failed seek cannot freeze the readout', () => {
    const p = createPlayheadStore()
    p.publish(600, 1_000, 500)
    p.ingest(100, 1_600)
    expect(p.get()).toBe(100)
  })
})
