import type { SubtitleCue } from '@/lib/subtitles'

/**
 * Is the active caption set unchanged? Compared by cue OBJECT, not id: within one subtitle file
 * the lookup hands back the same objects, so the overlay keeps its state between playhead ticks;
 * a replacement file has fresh objects (even where its cue ids collide with the old file's), so
 * the new text shows at once — also while paused, when the playhead never moves to force it.
 */
export function sameActiveCues(prev: readonly SubtitleCue[], next: readonly SubtitleCue[]): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false
  return true
}

/**
 * Last-resort caption cap (lib/player/layout 'captions' compaction): spread `maxLines` rendered
 * lines over the active cues. `cueLines[i]` is cue i's logical line count; the result gives each
 * logical line its `numberOfLines` (0 = not drawn), or null when nothing needs capping.
 *
 * Each extra cue plate costs about a line of height (padding + gap), so it is charged one. When
 * not every cue fits, the NEWEST cues are kept (the older one is about to end). Within the kept
 * cues every logical line gets one row first, in order; spare rows then let lines wrap, spread
 * evenly from the top. The total never exceeds the budget.
 */
export function captionLineBudget(cueLines: readonly number[], maxLines: number | undefined): number[][] | null {
  if (maxLines === undefined || !(maxLines >= 1)) return null
  const counts = cueLines.map((n) => Math.max(1, Math.floor(n)))
  const m = Math.floor(maxLines)
  const keep = Math.min(counts.length, Math.floor((m + 1) / 2))
  const first = counts.length - keep
  let budget = m - Math.max(0, keep - 1)
  const total = counts.slice(first).reduce((a, n) => a + n, 0)
  const extra = Math.max(0, budget - total)
  const share = total > 0 ? Math.floor(extra / total) : 0
  let remainder = total > 0 ? extra - share * total : 0
  return counts.map((n, cue) =>
    Array.from({ length: n }, () => {
      if (cue < first || budget <= 0) return 0
      let lines = 1 + share
      if (remainder > 0) {
        lines += 1
        remainder -= 1
      }
      lines = Math.min(lines, budget)
      budget -= lines
      return lines
    }),
  )
}
