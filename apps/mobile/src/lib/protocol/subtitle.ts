/**
 * Subtitle distribution metadata. The roster is re-broadcast on every whole-percent of every
 * guest's download, so it must stay small: it carries only `{ name, sizeBytes, rev }`. The SRT
 * body travels once per revision in a `subtitle` message — pushed when the host attaches or
 * replaces it, and pulled (`subtitleRequest`) by a guest whose local revision differs from the
 * roster's (just approved, or reconnected after missing a replacement). Pure + unit-tested.
 */

import type { MediaInfo } from './session'

export type SubtitleMeta = NonNullable<MediaInfo['subtitle']>

/** Display-name cap for a subtitle file (UI shows it on one line). */
export const SUBTITLE_NAME_MAX = 120
/** Hard cap on a subtitle body over the control channel (a feature-length SRT is ~50–200 KB). */
export const SUBTITLE_MAX_BYTES = 2_000_000

/** Real UTF-8 byte length of a JS string (String#length counts UTF-16 units). */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4 // a surrogate pair is one 4-byte code point
        i++
      } else bytes += 3 // lone high surrogate → U+FFFD on encode
    } else bytes += 3
  }
  return bytes
}

/**
 * Content revision: FNV-1a (32-bit) over the UTF-16 units plus the length, as "s1:<hex>". Not a
 * security hash — it only has to change when the file changes, so a same-name replacement
 * (movie.srt → corrected movie.srt) is detected where a name comparison would miss it.
 */
export function subtitleRev(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `s1:${(h >>> 0).toString(16).padStart(8, '0')}-${content.length.toString(16)}`
}

/** Roster metadata for an attached subtitle (never the body). */
export function subtitleMeta(name: string, content: string): SubtitleMeta {
  return { name, sizeBytes: utf8ByteLength(content), rev: subtitleRev(content) }
}

/** Validate subtitle metadata off the roster (untrusted network input). */
export function isSubtitleMeta(v: unknown): v is SubtitleMeta {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    o.name.length <= SUBTITLE_NAME_MAX &&
    typeof o.sizeBytes === 'number' &&
    Number.isFinite(o.sizeBytes) &&
    o.sizeBytes >= 0 &&
    typeof o.rev === 'string' &&
    o.rev.length > 0 &&
    o.rev.length <= 64
  )
}

/** A validated `subtitle` frame: either a body to load (with its revision) or a clear. */
export type SubtitlePayload = { kind: 'load'; name: string; content: string; rev: string } | { kind: 'clear' }

/**
 * Validate a `subtitle` frame. An empty name+content is the host's "removed" signal. The revision
 * is always recomputed from the body we actually received, so a frame can't claim a rev it
 * doesn't carry.
 */
export function parseSubtitlePayload(msg: unknown): SubtitlePayload | null {
  if (typeof msg !== 'object' || msg === null) return null
  const o = msg as Record<string, unknown>
  if (o.t !== 'subtitle' || typeof o.name !== 'string' || typeof o.content !== 'string') return null
  if (o.name === '' && o.content === '') return { kind: 'clear' }
  if (!o.name || !o.content || o.name.length > SUBTITLE_NAME_MAX) return null
  if (utf8ByteLength(o.content) > SUBTITLE_MAX_BYTES) return null
  return { kind: 'load', name: o.name, content: o.content, rev: subtitleRev(o.content) }
}

/**
 * Should a guest ask the host for the subtitle body? Yes when the roster names a revision we
 * don't have and haven't already asked for on this connection.
 */
export function needsSubtitleFetch(
  localRev: string | null,
  roster: SubtitleMeta | null | undefined,
  requestedRev: string | null,
): boolean {
  if (!roster) return false
  if (roster.rev === localRev) return false
  return roster.rev !== requestedRev
}
