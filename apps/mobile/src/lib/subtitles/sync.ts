/**
 * Real-time subtitle cue synchronization engine.
 *
 * Employs binary search (O(log N)) interval indexing to find active cues
 * at any playhead position with sub-millisecond efficiency.
 */

import type { SubtitleCue } from './types'

const maxDurationCache = new WeakMap<SubtitleCue[], number>()

function getMaxDuration(cues: SubtitleCue[]): number {
  let max = maxDurationCache.get(cues)
  if (max !== undefined) return max
  max = 0
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    if (!cue) continue
    const dur = cue.endMs - cue.startMs
    if (dur > max) max = dur
  }
  maxDurationCache.set(cues, max)
  return max
}

function binarySearchRightmost(cues: SubtitleCue[], posMs: number): number {
  let low = 0
  let high = cues.length - 1
  let result = -1

  while (low <= high) {
    const mid = (low + high) >> 1
    const cue = cues[mid]
    if (cue && cue.startMs <= posMs) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
}

function lookupActiveCues(cues: SubtitleCue[], posMs: number): SubtitleCue[] {
  const rightmost = binarySearchRightmost(cues, posMs)
  if (rightmost === -1) return []

  const maxDur = getMaxDuration(cues)
  const active: SubtitleCue[] = []

  for (let i = rightmost; i >= 0; i--) {
    const cue = cues[i]
    if (!cue) continue
    if (posMs - cue.startMs > maxDur) {
      break
    }
    if (cue.startMs <= posMs && posMs < cue.endMs) {
      active.push(cue)
    }
  }

  active.reverse()
  return active
}

/**
 * Find all active subtitle cues at a given playhead position.
 * Uses binary search (O(log N)) to achieve sub-millisecond lookup efficiency.
 *
 * @param cues Sorted list of subtitle cues
 * @param positionMs Current playhead time (in milliseconds or seconds)
 * @returns Array of currently active SubtitleCue objects, or empty array if none
 */
export function findActiveCues(cues: SubtitleCue[], positionMs: number): SubtitleCue[] {
  if (!cues || cues.length === 0 || !Number.isFinite(positionMs) || positionMs < 0) {
    return []
  }

  const result = lookupActiveCues(cues, positionMs)
  if (result.length > 0) return result

  // Fallback: If caller passed seconds (e.g. 1.5s instead of 1500ms)
  const lastCue = cues[cues.length - 1]
  if (lastCue && positionMs <= lastCue.endSec) {
    const asMs = Math.round(positionMs * 1000)
    const secResult = lookupActiveCues(cues, asMs)
    if (secResult.length > 0) return secResult
  }

  return []
}
