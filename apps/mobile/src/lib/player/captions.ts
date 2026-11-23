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
