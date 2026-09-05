import { describe, it, expect } from 'vitest'
import { findActiveCues, type SubtitleCue } from '@/lib/subtitles'

function makeCue(id: number | string, startSec: number, endSec: number, text: string): SubtitleCue {
  const startMs = Math.round(startSec * 1000)
  const endMs = Math.round(endSec * 1000)
  return {
    id,
    startMs,
    endMs,
    startSec,
    endSec,
    text,
    rawText: text,
    lines: [{ text, spans: [{ text }] }],
  }
}

describe('Subtitle Synchronization (findActiveCues)', () => {
  const sampleCues: SubtitleCue[] = [
    makeCue(1, 1.0, 3.0, 'First cue (1s - 3s)'),
    makeCue(2, 5.0, 8.0, 'Second cue (5s - 8s)'),
    makeCue(3, 10.0, 14.0, 'Third cue (10s - 14s)'),
    makeCue(4, 14.0, 18.0, 'Fourth cue back-to-back (14s - 18s)'),
  ]

  describe('Interval & Boundary Conditions', () => {
    it('returns empty array when playhead is before first cue', () => {
      expect(findActiveCues(sampleCues, 500)).toEqual([])
      expect(findActiveCues(sampleCues, 999)).toEqual([])
      expect(findActiveCues(sampleCues, 0)).toEqual([])
    })

    it('returns cue exactly at startMs (inclusive)', () => {
      const active = findActiveCues(sampleCues, 1000)
      expect(active).toHaveLength(1)
      expect(active[0]!.id).toBe(1)
    })

    it('returns cue during active duration', () => {
      const active = findActiveCues(sampleCues, 2000)
      expect(active).toHaveLength(1)
      expect(active[0]!.id).toBe(1)
    })

    it('returns empty array exactly at endMs (exclusive end boundary)', () => {
      const active = findActiveCues(sampleCues, 3000)
      expect(active).toEqual([])
    })

    it('returns empty array in the gap between cues', () => {
      expect(findActiveCues(sampleCues, 3500)).toEqual([])
      expect(findActiveCues(sampleCues, 4999)).toEqual([])
    })

    it('returns empty array after the last cue', () => {
      expect(findActiveCues(sampleCues, 18000)).toEqual([])
      expect(findActiveCues(sampleCues, 50000)).toEqual([])
    })

    it('handles back-to-back cues with 0ms gap cleanly', () => {
      // Cue 3 ends at 14.0s (14000ms), Cue 4 starts at 14.0s (14000ms)
      const at13999 = findActiveCues(sampleCues, 13999)
      expect(at13999).toHaveLength(1)
      expect(at13999[0]!.id).toBe(3)

      const at14000 = findActiveCues(sampleCues, 14000)
      expect(at14000).toHaveLength(1)
      expect(at14000[0]!.id).toBe(4)
    })
  })

  describe('Overlapping Cues', () => {
    const overlappingCues: SubtitleCue[] = [
      makeCue('c1', 1.0, 5.0, 'Speaker 1'),
      makeCue('c2', 2.0, 4.0, 'Speaker 2 (overlapping)'),
      makeCue('c3', 6.0, 9.0, 'Speaker 3'),
    ]

    it('returns both cues when they overlap simultaneously', () => {
      const active = findActiveCues(overlappingCues, 3000)
      expect(active).toHaveLength(2)
      expect(active[0]!.id).toBe('c1')
      expect(active[1]!.id).toBe('c2')
    })

    it('returns only the remaining cue after the inner cue expires', () => {
      const active = findActiveCues(overlappingCues, 4500)
      expect(active).toHaveLength(1)
      expect(active[0]!.id).toBe('c1')
    })
  })

  describe('Playhead Seeking Dynamics', () => {
    it('handles instant large forward seeks', () => {
      // Seek from 0s -> 6s (Cue 2)
      const forward = findActiveCues(sampleCues, 6000)
      expect(forward).toHaveLength(1)
      expect(forward[0]!.id).toBe(2)

      // Seek from 6s -> 15s (Cue 4)
      const further = findActiveCues(sampleCues, 15000)
      expect(further).toHaveLength(1)
      expect(further[0]!.id).toBe(4)
    })

    it('handles instant backward seeks (rewind 10s / 30s)', () => {
      // Seek backwards from 16s -> 2s (Cue 1)
      const rewind = findActiveCues(sampleCues, 2000)
      expect(rewind).toHaveLength(1)
      expect(rewind[0]!.id).toBe(1)

      // Seek backwards into a gap (3.5s)
      const gap = findActiveCues(sampleCues, 3500)
      expect(gap).toEqual([])
    })
  })

  describe('Rate Nudges & Time Scaling', () => {
    it('accurately tracks active cues during variable playback rates', () => {
      // Simulating playhead advancement at 0.85x, 1.0x, and 1.15x
      const rates = [0.85, 1.0, 1.15]

      for (const rate of rates) {
        let playheadSec = 0
        const dtSec = 0.05 * rate // 50ms ticks scaled by rate

        let cue1Observed = false
        let gapObserved = false
        let cue2Observed = false

        while (playheadSec < 7.0) {
          const playheadMs = Math.round(playheadSec * 1000)
          const active = findActiveCues(sampleCues, playheadMs)
          if (playheadMs >= 1000 && playheadMs < 3000) {
            expect(active).toHaveLength(1)
            expect(active[0]!.id).toBe(1)
            cue1Observed = true
          } else if (playheadMs >= 3000 && playheadMs < 5000) {
            expect(active).toEqual([])
            gapObserved = true
          } else if (playheadMs >= 5000 && playheadMs < 8000) {
            expect(active).toHaveLength(1)
            expect(active[0]!.id).toBe(2)
            cue2Observed = true
          }
          playheadSec += dtSec
        }

        expect(cue1Observed).toBe(true)
        expect(gapObserved).toBe(true)
        expect(cue2Observed).toBe(true)
      }
    })
  })

  describe('Seconds vs Milliseconds Parameter Tolerance', () => {
    it('accepts playhead position in seconds directly', () => {
      const active = findActiveCues(sampleCues, 1.5) // 1.5 seconds = 1500 ms
      expect(active).toHaveLength(1)
      expect(active[0]!.id).toBe(1)
    })

    it('returns empty array when seconds position lands in a gap', () => {
      const active = findActiveCues(sampleCues, 4.0) // 4.0 seconds = 4000 ms (gap)
      expect(active).toEqual([])
    })
  })

  describe('Large Dataset & Binary Search Performance', () => {
    it('executes binary search on 3000 cues with sub-millisecond latency', () => {
      // Generate 3,000 cues spanning ~2.5 hours of video
      const movieCues: SubtitleCue[] = []
      let cursor = 10
      for (let i = 1; i <= 3000; i++) {
        const duration = 2 + (i % 3) // 2s to 4s
        movieCues.push(makeCue(i, cursor, cursor + duration, `Cue ${i}`))
        cursor += duration + 1 // 1s gap
      }

      // Benchmark 2,000 lookups
      const startTime = performance.now()
      for (let i = 0; i < 2000; i++) {
        const targetSec = (i * 3.7) % cursor
        findActiveCues(movieCues, targetSec * 1000)
      }
      const durationMs = performance.now() - startTime

      // 2,000 binary search lookups should complete in well under 50ms
      expect(durationMs).toBeLessThan(100)

      // Validate exact lookup on cue 1500
      const targetCue = movieCues[1499]!
      const active = findActiveCues(movieCues, targetCue.startMs + 500)
      expect(active).toHaveLength(1)
      expect(active[0]!.id).toBe(1500)
    })
  })

  describe('Edge Cases & Resiliency', () => {
    it('returns empty array for empty cues list', () => {
      expect(findActiveCues([], 1000)).toEqual([])
    })

    it('returns empty array for negative playhead positions', () => {
      expect(findActiveCues(sampleCues, -100)).toEqual([])
      expect(findActiveCues(sampleCues, -0.01)).toEqual([])
    })

    it('returns empty array for non-finite values (NaN, Infinity)', () => {
      expect(findActiveCues(sampleCues, Number.NaN)).toEqual([])
      expect(findActiveCues(sampleCues, Number.POSITIVE_INFINITY)).toEqual([])
      expect(findActiveCues(sampleCues, Number.NEGATIVE_INFINITY)).toEqual([])
    })
  })
})
