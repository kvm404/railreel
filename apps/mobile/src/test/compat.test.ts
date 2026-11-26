import { describe, it, expect } from 'vitest'
import { audioCodecName, mediaVerdict, videoCodecName, type MediaProbeFacts } from '@/lib/media/compat'

const good: MediaProbeFacts = {
  container: 'mp4',
  videoMime: 'video/avc',
  audioMime: 'audio/mp4a-latm',
  trackCount: 2,
}
const probe = (over: Partial<MediaProbeFacts>): MediaProbeFacts => ({ ...good, ...over })

describe('mediaVerdict — accepted', () => {
  it('accepts H.264 + AAC in an MP4', () => {
    expect(mediaVerdict(good)).toEqual({ ok: true })
  })

  it('accepts a QuickTime (.mov) container with H.264 + AAC', () => {
    expect(mediaVerdict(probe({ container: 'quicktime' }))).toEqual({ ok: true })
  })

  it('accepts a silent H.264 video (no audio track)', () => {
    expect(mediaVerdict(probe({ audioMime: '', trackCount: 1 }))).toEqual({ ok: true })
  })

  it('accepts extra tracks (subtitles, second AAC) — only the first of each kind is judged', () => {
    expect(mediaVerdict(probe({ trackCount: 5 }))).toEqual({ ok: true })
  })

  it('accepts HEVC (H.265) + AAC — a Galaxy camera recording with "High efficiency video" on', () => {
    expect(mediaVerdict(probe({ videoMime: 'video/hevc' }))).toEqual({ ok: true })
    expect(mediaVerdict(probe({ container: 'quicktime', videoMime: 'video/hevc' }))).toEqual({ ok: true })
  })

  it('accepts an MKV with H.264 or HEVC video and AAC audio', () => {
    expect(mediaVerdict(probe({ container: 'matroska' }))).toEqual({ ok: true })
    expect(mediaVerdict(probe({ container: 'matroska', videoMime: 'video/hevc' }))).toEqual({ ok: true })
  })

  it('accepts a silent MKV when its own track list confirmed there is no audio', () => {
    expect(mediaVerdict(probe({ container: 'matroska', audioMime: '', trackCount: 1, tracksVerified: true }))).toEqual({ ok: true })
  })

  it('refuses to call an MKV silent when its track list could not be read (the extractor hides Dolby/DTS)', () => {
    for (const tracksVerified of [false, undefined]) {
      const v = mediaVerdict(probe({ container: 'matroska', audioMime: '', trackCount: 1, tracksVerified }))
      expect(v).toMatchObject({ ok: false, reason: 'audio-codec' })
      if (!v.ok) expect(v.message).toMatch(/couldn't read this MKV's sound track/)
    }
  })

  it('takes an MKV the track list read as AC-3 / DTS for what it is (rejected by name)', () => {
    expect(mediaVerdict(probe({ container: 'matroska', audioMime: 'audio/ac3', tracksVerified: true }))).toMatchObject({ reason: 'audio-codec' })
    const v = mediaVerdict(probe({ container: 'matroska', audioMime: 'audio/vnd.dts', tracksVerified: true }))
    if (!v.ok) expect(v.message).toContain('sound is DTS.')
  })

  it('an unverified MKV that does report AAC is still fine (the extractor only hides, never invents)', () => {
    expect(mediaVerdict(probe({ container: 'matroska', tracksVerified: false }))).toEqual({ ok: true })
  })

  it('is case- and whitespace-insensitive about mimes and the container hint', () => {
    expect(mediaVerdict(probe({ container: ' MP4 ', videoMime: 'Video/AVC', audioMime: 'AUDIO/MP4A-LATM' }))).toEqual({ ok: true })
  })
})

describe('mediaVerdict — unreadable', () => {
  it('rejects a failed probe (null/undefined)', () => {
    for (const p of [null, undefined]) {
      const v = mediaVerdict(p)
      expect(v.ok).toBe(false)
      if (!v.ok) {
        expect(v.reason).toBe('unreadable')
        expect(v.message).toMatch(/couldn't read this file/)
      }
    }
  })

  it('rejects an unrecognised container that yielded no tracks', () => {
    const v = mediaVerdict(probe({ container: 'unknown', videoMime: '', audioMime: '', trackCount: 0 }))
    expect(v).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('treats a missing/garbled probe shape (old native build) as unreadable, never as a pass', () => {
    expect(mediaVerdict({} as MediaProbeFacts)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(mediaVerdict({ ...good, trackCount: NaN, container: 'unknown' })).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

describe('mediaVerdict — container', () => {
  it('rejects other containers that did parse (AVI, TS, FLV…) and names what is supported', () => {
    const v = mediaVerdict(probe({ container: 'unknown', trackCount: 2 }))
    expect(v).toMatchObject({ ok: false, reason: 'container' })
    if (!v.ok) {
      expect(v.message).toMatch(/isn't an MP4, MOV or MKV/)
      expect(v.message).toMatch(/H\.264 or HEVC video with AAC sound/)
      expect(v.message).toMatch(/HandBrake: 'Fast 1080p30'/)
    }
  })

  it('checks the container before the codecs', () => {
    expect(mediaVerdict(probe({ container: 'unknown', videoMime: 'video/av01', trackCount: 2 }))).toMatchObject({ reason: 'container' })
  })

  it('judges a WebM (a Matroska file) by its codecs: VP9 video is rejected as a codec, not a container', () => {
    const v = mediaVerdict(probe({ container: 'matroska', videoMime: 'video/x-vnd.on2.vp9', audioMime: 'audio/opus', tracksVerified: true }))
    expect(v).toMatchObject({ ok: false, reason: 'video-codec' })
    if (!v.ok) expect(v.message).toContain('uses VP9.')
  })

  it('an MKV whose tracks the extractor could not read is unreadable, not "audio only"', () => {
    expect(mediaVerdict({ container: 'matroska', videoMime: '', audioMime: '', trackCount: 0 })).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

describe('mediaVerdict — no video', () => {
  it('rejects an audio-only file', () => {
    const v = mediaVerdict(probe({ videoMime: '', trackCount: 1 }))
    expect(v).toMatchObject({ ok: false, reason: 'no-video' })
    if (!v.ok) expect(v.message).toMatch(/no video/)
  })

  it('rejects a file whose "video" mime is not a video type', () => {
    expect(mediaVerdict(probe({ videoMime: 'image/jpeg' }))).toMatchObject({ reason: 'no-video' })
  })
})

describe('mediaVerdict — video codec', () => {
  it('explains AV1 with the friendly name, what is supported and the conversion preset', () => {
    const v = mediaVerdict(probe({ videoMime: 'video/av01' }))
    expect(v).toEqual({
      ok: false,
      reason: 'video-codec',
      message:
        "This file uses AV1. RailReel shares H.264 or HEVC video with AAC sound (MP4, MOV or MKV) so every phone can play it — convert it first (HandBrake: 'Fast 1080p30').",
    })
  })

  it.each([
    ['video/av01', 'AV1'],
    ['video/x-vnd.on2.vp9', 'VP9'],
    ['video/x-vnd.on2.vp8', 'VP8'],
    ['video/dolby-vision', 'Dolby Vision'],
    ['video/mp4v-es', 'MPEG-4 Part 2'],
    ['video/3gpp', 'H.263'],
    ['video/mpeg2', 'MPEG-2'],
  ])('rejects %s as %s', (mime, name) => {
    const v = mediaVerdict(probe({ videoMime: mime }))
    expect(v).toMatchObject({ ok: false, reason: 'video-codec' })
    if (!v.ok) expect(v.message).toContain(`uses ${name}.`)
  })

  it('names an unknown video mime by its subtype instead of hiding it', () => {
    const v = mediaVerdict(probe({ videoMime: 'video/x-weird' }))
    expect(v).toMatchObject({ ok: false, reason: 'video-codec' })
    if (!v.ok) expect(v.message).toContain('uses x-weird.')
  })

  it('reports the video codec first when both video and audio are wrong', () => {
    expect(mediaVerdict(probe({ videoMime: 'video/av01', audioMime: 'audio/ac3' }))).toMatchObject({ reason: 'video-codec' })
  })
})

describe('mediaVerdict — audio codec', () => {
  it('judges HEVC and MKV files by their audio too (the common x265 MKV with AC-3 is rejected)', () => {
    expect(mediaVerdict(probe({ container: 'matroska', videoMime: 'video/hevc', audioMime: 'audio/ac3' }))).toMatchObject({
      ok: false,
      reason: 'audio-codec',
    })
  })

  it('explains AC3 with the friendly name', () => {
    const v = mediaVerdict(probe({ audioMime: 'audio/ac3' }))
    expect(v).toMatchObject({ ok: false, reason: 'audio-codec' })
    if (!v.ok) {
      expect(v.message).toContain('sound is Dolby Digital (AC-3).')
      expect(v.message).toMatch(/AAC audio/)
      expect(v.message).toMatch(/HandBrake: 'Fast 1080p30'/)
    }
  })

  it.each([
    ['audio/eac3', 'Dolby Digital Plus (E-AC-3)'],
    ['audio/eac3-joc', 'Dolby Atmos (E-AC-3 JOC)'],
    ['audio/true-hd', 'Dolby TrueHD'],
    ['audio/vnd.dts', 'DTS'],
    ['audio/vnd.dts.hd', 'DTS-HD'],
    ['audio/opus', 'Opus'],
    ['audio/vorbis', 'Vorbis'],
    ['audio/flac', 'FLAC'],
    ['audio/mpeg', 'MP3'],
    ['audio/raw', 'uncompressed PCM'],
  ])('rejects %s as %s', (mime, name) => {
    const v = mediaVerdict(probe({ audioMime: mime }))
    expect(v).toMatchObject({ ok: false, reason: 'audio-codec' })
    if (!v.ok) expect(v.message).toContain(`sound is ${name}.`)
  })

  it('names an unknown audio mime by its subtype', () => {
    const v = mediaVerdict(probe({ audioMime: 'audio/x-odd' }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toContain('sound is x-odd.')
  })
})

// The native probe fills gaps the platform extractor leaves (avc3 fragmented MP4s, a leading
// free/uuid box before ftyp) from the moov sample entries / a bounded box walk. Those paths feed
// the SAME facts into the verdict, so these pin how the verdict treats what they produce.
describe('mediaVerdict — facts from the native fallbacks', () => {
  it('accepts a fragmented MP4 whose avc3 entry the moov fallback mapped to video/avc', () => {
    expect(mediaVerdict({ container: 'mp4', videoMime: 'video/avc', audioMime: 'audio/mp4a-latm', trackCount: 2 })).toEqual({ ok: true })
  })

  it('accepts a moov-fallback result with video only (avc3 + no audio track)', () => {
    expect(mediaVerdict({ container: 'mp4', videoMime: 'video/avc', audioMime: '', trackCount: 1 })).toEqual({ ok: true })
  })

  it('accepts an MP4 recognised through a leading free/uuid box (container resolved to mp4)', () => {
    expect(mediaVerdict(probe({ container: 'mp4' }))).toEqual({ ok: true })
  })

  it('accepts a legacy QuickTime file made only of atoms (no ftyp)', () => {
    expect(mediaVerdict(probe({ container: 'quicktime' }))).toEqual({ ok: true })
  })

  it('accepts hvc1/hev1 entries the fallback mapped to HEVC', () => {
    expect(mediaVerdict(probe({ videoMime: 'video/hevc', audioMime: '', trackCount: 1 }))).toEqual({ ok: true })
  })

  it('still rejects dvh1/dvhe entries the fallback mapped to Dolby Vision', () => {
    expect(mediaVerdict(probe({ videoMime: 'video/dolby-vision' }))).toMatchObject({ ok: false, reason: 'video-codec' })
  })

  it.each([
    ['audio/ac3', 'Dolby Digital (AC-3)'],
    ['audio/eac3', 'Dolby Digital Plus (E-AC-3)'],
    ['audio/opus', 'Opus'],
    ['audio/alac', 'Apple Lossless (ALAC)'],
  ])('still rejects %s audio found by the fallback', (mime, name) => {
    const v = mediaVerdict(probe({ audioMime: mime }))
    expect(v).toMatchObject({ ok: false, reason: 'audio-codec' })
    if (!v.ok) expect(v.message).toContain(`sound is ${name}.`)
  })

  it('an ISO container where neither route found a track is "no video", not a pass', () => {
    expect(mediaVerdict({ container: 'mp4', videoMime: '', audioMime: '', trackCount: 0 })).toMatchObject({ ok: false, reason: 'no-video' })
  })

  it('a container nothing recognised (leading junk) with no tracks is unreadable', () => {
    expect(mediaVerdict({ container: 'unknown', videoMime: '', audioMime: '', trackCount: 0 })).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

describe('codec names', () => {
  it('maps known mimes, falls back to the subtype, then to a generic phrase', () => {
    expect(videoCodecName('video/hevc')).toBe('HEVC (H.265)')
    expect(videoCodecName('VIDEO/HEVC')).toBe('HEVC (H.265)')
    expect(videoCodecName('video/foo')).toBe('foo')
    expect(videoCodecName('')).toBe('an unsupported video codec')
    expect(audioCodecName('audio/ac3')).toBe('Dolby Digital (AC-3)')
    expect(audioCodecName('audio/mpeg-L2')).toBe('MP2')
    expect(audioCodecName('')).toBe('an unsupported audio codec')
  })
})
