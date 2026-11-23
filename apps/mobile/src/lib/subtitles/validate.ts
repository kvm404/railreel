/**
 * Validate a picked .srt BEFORE it is attached to the session. `attachSubtitle` happily stores
 * whatever it is given (and swallows parse failures), so an empty or non-SRT file used to look
 * "attached" with zero usable cues — and replaced a working subtitle. Pure + unit-tested.
 */

import { parseSrt } from './srt'

/** Subtitle text is broadcast over the control socket; real .srt files are tens of KB. */
export const MAX_SRT_CHARS = 2_000_000

export type SubtitleCheck =
  | { ok: true; cueCount: number }
  | { ok: false; reason: 'not-srt' | 'empty' | 'too-large' | 'no-cues'; message: string }

export function validateSrtFile(name: string, content: string): SubtitleCheck {
  if (!name.toLowerCase().endsWith('.srt')) {
    return { ok: false, reason: 'not-srt', message: 'Please select a .srt subtitle file.' }
  }
  if (!content || content.trim().length === 0) {
    return { ok: false, reason: 'empty', message: 'That subtitle file is empty.' }
  }
  if (content.length > MAX_SRT_CHARS) {
    return { ok: false, reason: 'too-large', message: 'That subtitle file is too large (over 2 MB).' }
  }
  const cueCount = parseSrt(content).length
  if (cueCount === 0) {
    return { ok: false, reason: 'no-cues', message: "No subtitles found in that file — it doesn't look like a valid .srt." }
  }
  return { ok: true, cueCount }
}
