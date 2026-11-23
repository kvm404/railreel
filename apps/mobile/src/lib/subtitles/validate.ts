/**
 * Validate a picked .srt BEFORE it is attached to the session. `attachSubtitle` happily stores
 * whatever it is given (and swallows parse failures), so an empty or non-SRT file used to look
 * "attached" with zero usable cues — and replaced a working subtitle. Pure + unit-tested.
 *
 * The size and name limits are the RECEIVERS' limits (lib/protocol/subtitle): guests drop a body
 * over SUBTITLE_MAX_BYTES of UTF-8 or a name over SUBTITLE_NAME_MAX, so the host must refuse such
 * a file here, visibly, rather than attach something no guest will ever show.
 */

import { SUBTITLE_MAX_BYTES, SUBTITLE_NAME_MAX, utf8ByteLength } from '../protocol/subtitle'
import { parseSrt } from './srt'

/** Cheap pre-check in UTF-16 units (a body over this can't be under the byte limit). */
export const MAX_SRT_CHARS = SUBTITLE_MAX_BYTES

export type SubtitleCheck =
  | { ok: true; cueCount: number }
  | { ok: false; reason: 'not-srt' | 'name-too-long' | 'empty' | 'too-large' | 'no-cues'; message: string }

export function validateSrtFile(name: string, content: string): SubtitleCheck {
  if (!name.toLowerCase().endsWith('.srt')) {
    return { ok: false, reason: 'not-srt', message: 'Please select a .srt subtitle file.' }
  }
  if (name.length > SUBTITLE_NAME_MAX) {
    return { ok: false, reason: 'name-too-long', message: `That file name is too long — rename it to under ${SUBTITLE_NAME_MAX} characters.` }
  }
  if (!content || content.trim().length === 0) {
    return { ok: false, reason: 'empty', message: 'That subtitle file is empty.' }
  }
  if (content.length > MAX_SRT_CHARS || utf8ByteLength(content) > SUBTITLE_MAX_BYTES) {
    return { ok: false, reason: 'too-large', message: 'That subtitle file is too large (over 2 MB).' }
  }
  const cueCount = parseSrt(content).length
  if (cueCount === 0) {
    return { ok: false, reason: 'no-cues', message: "No subtitles found in that file — it doesn't look like a valid .srt." }
  }
  return { ok: true, cueCount }
}
