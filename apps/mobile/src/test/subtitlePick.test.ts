import { describe, it, expect } from 'vitest'
import {
  base64ByteLength,
  isPickerCacheCopy,
  probeExceedsLimit,
  SUBTITLE_PROBE_BYTES,
  subtitleSizeVerdict,
} from '@/lib/subtitles/pick'
import { SUBTITLE_MAX_BYTES } from '@/lib/protocol'

describe('subtitleSizeVerdict', () => {
  it('accepts a file at or under the limit', () => {
    expect(subtitleSizeVerdict(50_000)).toBe('ok')
    expect(subtitleSizeVerdict(SUBTITLE_MAX_BYTES)).toBe('ok')
    expect(subtitleSizeVerdict(0)).toBe('ok')
  })

  it('rejects anything over 2,000,000 bytes before it is read', () => {
    expect(subtitleSizeVerdict(SUBTITLE_MAX_BYTES + 1)).toBe('too-large')
    expect(subtitleSizeVerdict(400_000_000)).toBe('too-large')
  })

  it('lets any one over-limit report reject, even if another claims it is small', () => {
    expect(subtitleSizeVerdict(1_000, 900_000_000)).toBe('too-large')
    expect(subtitleSizeVerdict(undefined, 900_000_000)).toBe('too-large')
  })

  it('is unknown (probe it) when no usable size was reported', () => {
    expect(subtitleSizeVerdict()).toBe('unknown')
    expect(subtitleSizeVerdict(undefined, null)).toBe('unknown')
    expect(subtitleSizeVerdict(Number.NaN, -1)).toBe('unknown')
  })

  it('trusts the one size it has', () => {
    expect(subtitleSizeVerdict(undefined, 1_000)).toBe('ok')
  })
})

describe('bounded probe', () => {
  it('measures base64 without decoding it', () => {
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength('QQ==')).toBe(1)
    expect(base64ByteLength('QUI=')).toBe(2)
    expect(base64ByteLength('QUJD')).toBe(3)
  })

  it('flags a probe that reached past the limit', () => {
    const over = 'A'.repeat(Math.ceil((SUBTITLE_PROBE_BYTES * 4) / 3))
    const under = 'A'.repeat(Math.floor(((SUBTITLE_MAX_BYTES - 10) * 4) / 3))
    expect(probeExceedsLimit(over)).toBe(true)
    expect(probeExceedsLimit(under)).toBe(false)
  })
})

describe('isPickerCacheCopy', () => {
  const cache = 'file:///data/user/0/app/cache/'

  it('deletes only file:// copies inside the app cache', () => {
    expect(isPickerCacheCopy(`${cache}DocumentPicker/abc.srt`, cache)).toBe(true)
    expect(isPickerCacheCopy(`${cache}DocumentPicker/abc.srt`, 'file:///data/user/0/app/cache')).toBe(true)
  })

  it("never touches the user's original", () => {
    expect(isPickerCacheCopy('content://media/external/file/12', cache)).toBe(false)
    expect(isPickerCacheCopy('file:///storage/emulated/0/Download/x.srt', cache)).toBe(false)
    expect(isPickerCacheCopy(`${cache}../files/x.srt`, cache)).toBe(false)
    expect(isPickerCacheCopy('', cache)).toBe(false)
    expect(isPickerCacheCopy(`${cache}x.srt`, '')).toBe(false)
    expect(isPickerCacheCopy(undefined, cache)).toBe(false)
  })
})
