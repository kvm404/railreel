/**
 * Guards for the host's subtitle picker. The document picker copies the chosen file into the app
 * cache BEFORE we see it, and the old flow then read the whole copy into a JS string and only
 * validated its size afterwards — so a multi-hundred-megabyte file renamed `.srt` could exhaust
 * memory and take the session down. These decisions run first, on sizes alone. Pure + unit-tested.
 */

import { SUBTITLE_MAX_BYTES } from '../protocol/subtitle'

export const SUBTITLE_TOO_LARGE_MESSAGE = 'That subtitle file is too large (over 2 MB).'

export type SizeVerdict = 'ok' | 'too-large' | 'unknown'

/**
 * Judge a file by every size we were told about (the picker's, the on-disk copy's). Any one over
 * the limit rejects it; with no usable number at all the size is unknown and the caller must
 * probe with a bounded read instead of trusting the file.
 */
export function subtitleSizeVerdict(...reported: (number | null | undefined)[]): SizeVerdict {
  const sizes = reported.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  if (sizes.length === 0) return 'unknown'
  return sizes.some((n) => n > SUBTITLE_MAX_BYTES) ? 'too-large' : 'ok'
}

/** Bytes a bounded probe may read to tell "within the limit" from "over it" (one past the limit). */
export const SUBTITLE_PROBE_BYTES = SUBTITLE_MAX_BYTES + 1

/** Decoded byte length of a base64 string, without decoding it. */
export function base64ByteLength(b64: string): number {
  const len = b64.length
  if (len === 0) return 0
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

/** After a bounded probe read of `SUBTITLE_PROBE_BYTES`: did the file reach past the limit? */
export function probeExceedsLimit(probeBase64: string): boolean {
  return base64ByteLength(probeBase64) > SUBTITLE_MAX_BYTES
}

/**
 * Only ever delete what the picker copied for us: a `file://` path inside the app cache. If the
 * copy failed and the asset still points at the user's original (a content:// URI, or a file
 * elsewhere), it must be left strictly alone.
 */
export function isPickerCacheCopy(uri: string | null | undefined, cacheDir: string | null | undefined): boolean {
  if (!uri || !cacheDir) return false
  const dir = cacheDir.endsWith('/') ? cacheDir : `${cacheDir}/`
  return uri.startsWith('file://') && uri.startsWith(dir) && !uri.slice(dir.length).includes('..')
}
