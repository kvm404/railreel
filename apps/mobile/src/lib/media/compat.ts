/**
 * Media compatibility verdict (pure). PRD §7 / architecture §7: RailReel shares only video every
 * guest phone can decode — H.264 (AVC) or HEVC (H.265) video, with AAC audio or none, in an MP4,
 * MOV or MKV container. Every guest downloads its own copy, so a file the host can play but a
 * guest can't is a multi-GB download that ends in a player error. The native probe reports the
 * REAL container + track mimes; this turns them into either "go" or the exact sentence the host
 * sees. Copy lives here so it is tested and the screens stay dumb.
 *
 * Why these: Android ships an H.264 and an HEVC decoder on every phone RailReel targets, and AAC
 * is the one compressed audio format every phone plays. MKV only changes the wrapper (Media3
 * reads it), but it can't play while downloading — guests pre-cache it (no `fastStart`). How well
 * a given phone handles a big HEVC frame is a per-guest question: each guest checks its own
 * decoder (lib/media/preflight decodeWarning) and the host's lobby flags anyone who can't.
 */

export interface MediaProbeFacts {
  /** "mp4" | "quicktime" | "matroska" | "unknown" — sniffed from the first bytes (WebM is matroska). */
  container: string
  /** Mime of the first video track ("" = none), e.g. "video/avc". */
  videoMime: string
  /** Mime of the first audio track ("" = none), e.g. "audio/mp4a-latm". */
  audioMime: string
  /** Every track the extractor found. */
  trackCount: number
  /**
   * false: the mimes may be missing tracks — an MKV whose own track list the native probe couldn't
   * read, where the platform extractor silently drops codecs it can't decode (AC-3, DTS, TrueHD).
   * Absent (an older native build) counts as unverified for an MKV.
   */
  tracksVerified?: boolean
}

export type MediaRejection = 'container' | 'video-codec' | 'audio-codec' | 'no-video' | 'unreadable'

export type MediaVerdict = { ok: true } | { ok: false; reason: MediaRejection; message: string }

export const ACCEPTED_VIDEO_MIMES: readonly string[] = ['video/avc', 'video/hevc']
export const ACCEPTED_AUDIO_MIME = 'audio/mp4a-latm'
export const ACCEPTED_CONTAINERS: readonly string[] = ['mp4', 'quicktime', 'matroska']

/** What the host is told RailReel can share — one phrase, reused by every rejection. */
const SUPPORTED = 'RailReel shares H.264 or HEVC video with AAC sound (MP4, MOV or MKV) so every phone can play it'

const VIDEO_NAMES: Record<string, string> = {
  'video/hevc': 'HEVC (H.265)',
  'video/av01': 'AV1',
  'video/x-vnd.on2.vp9': 'VP9',
  'video/x-vnd.on2.vp8': 'VP8',
  'video/dolby-vision': 'Dolby Vision',
  'video/mp4v-es': 'MPEG-4 Part 2',
  'video/3gpp': 'H.263',
  'video/mpeg2': 'MPEG-2',
  'video/x-ms-wmv': 'WMV',
}

const AUDIO_NAMES: Record<string, string> = {
  'audio/ac3': 'Dolby Digital (AC-3)',
  'audio/eac3': 'Dolby Digital Plus (E-AC-3)',
  'audio/eac3-joc': 'Dolby Atmos (E-AC-3 JOC)',
  'audio/true-hd': 'Dolby TrueHD',
  'audio/vnd.dts': 'DTS',
  'audio/vnd.dts.hd': 'DTS-HD',
  'audio/opus': 'Opus',
  'audio/vorbis': 'Vorbis',
  'audio/flac': 'FLAC',
  'audio/alac': 'Apple Lossless (ALAC)',
  'audio/mpeg': 'MP3',
  'audio/mpeg-l2': 'MP2',
  'audio/raw': 'uncompressed PCM',
  'audio/amr-wb': 'AMR-WB',
  'audio/3gpp': 'AMR-NB',
}

const CONVERT_HINT = "HandBrake: 'Fast 1080p30'"

const UNREADABLE: MediaVerdict = {
  ok: false,
  reason: 'unreadable',
  message: `RailReel couldn't read this file — it may be damaged or still downloading. Try another, or convert it to an H.264 MP4 (${CONVERT_HINT}).`,
}

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** "HEVC (H.265)" for a known mime; otherwise the bare subtype ("video/foo" → "foo"). */
function friendly(table: Record<string, string>, mime: string, fallback: string): string {
  const key = norm(mime)
  return table[key] ?? (key.split('/')[1] || fallback)
}

export function videoCodecName(mime: string): string {
  return friendly(VIDEO_NAMES, mime, 'an unsupported video codec')
}

export function audioCodecName(mime: string): string {
  return friendly(AUDIO_NAMES, mime, 'an unsupported audio codec')
}

/**
 * Decide whether the picked file may be hosted. `null` = the probe itself failed (the native side
 * could not parse the container at all). A video with NO audio track is allowed — guests still
 * sync to the same clock and a silent film is the host's call, not a compatibility problem.
 */
export function mediaVerdict(probe: MediaProbeFacts | null | undefined): MediaVerdict {
  if (!probe || typeof probe !== 'object') return UNREADABLE
  const container = norm(probe.container)
  const videoMime = norm(probe.videoMime)
  const audioMime = norm(probe.audioMime)
  const trackCount = Number.isFinite(probe.trackCount) ? probe.trackCount : 0

  if (!ACCEPTED_CONTAINERS.includes(container)) {
    // Nothing parsed and nothing recognisable: damaged/empty rather than "wrong format".
    if (trackCount <= 0) return UNREADABLE
    return {
      ok: false,
      reason: 'container',
      message: `This file isn't an MP4, MOV or MKV. ${SUPPORTED} — convert it first (${CONVERT_HINT}).`,
    }
  }

  // The native probe names a Matroska file by its magic even when the platform extractor then
  // fails on it (it has no moov fallback like ISO files do): nothing read is unreadable, not
  // "audio only".
  if (container === 'matroska' && trackCount <= 0) return UNREADABLE
  if (!videoMime.startsWith('video/')) {
    return {
      ok: false,
      reason: 'no-video',
      message: "There's no video in this file — it looks like audio only. Pick a movie instead.",
    }
  }
  if (!ACCEPTED_VIDEO_MIMES.includes(videoMime)) {
    return {
      ok: false,
      reason: 'video-codec',
      message: `This file uses ${videoCodecName(videoMime)}. ${SUPPORTED} — convert it first (${CONVERT_HINT}).`,
    }
  }
  // "No audio" in an MKV is only believed when its own track list said so: otherwise a Dolby/DTS
  // track the extractor dropped would pass as a silent film.
  if (container === 'matroska' && audioMime === '' && probe.tracksVerified !== true) {
    return {
      ok: false,
      reason: 'audio-codec',
      message: `RailReel couldn't read this MKV's sound track — it may be Dolby or DTS, which not every phone can play. ${SUPPORTED} — convert it first (${CONVERT_HINT}, with AAC audio).`,
    }
  }
  // No audio track at all is fine (see above); an audio track in the wrong codec is not.
  if (audioMime !== '' && audioMime !== ACCEPTED_AUDIO_MIME) {
    return {
      ok: false,
      reason: 'audio-codec',
      message: `This file's sound is ${audioCodecName(audioMime)}. ${SUPPORTED} — convert it first (${CONVERT_HINT}, with AAC audio).`,
    }
  }
  return { ok: true }
}
