import { describe, it, expect } from 'vitest'
import { batteryWarning, decodeWarning, storageWarning, STORAGE_MARGIN_BYTES } from '@/lib/media/preflight'

describe('storageWarning', () => {
  const MOVIE = 2_000_000_000 // 2 GB

  it('is silent with comfortable room', () => {
    expect(storageWarning(MOVIE + STORAGE_MARGIN_BYTES, MOVIE)).toBeNull()
  })

  it('warns when the movie plus margin does not fit', () => {
    const w = storageWarning(MOVIE, MOVIE)
    expect(w).toMatch(/Not enough space/)
    expect(w).toMatch(/2\.2 GB free/)
  })

  it('never blocks on unknown readings', () => {
    expect(storageWarning(-1, MOVIE)).toBeNull()
    expect(storageWarning(NaN, MOVIE)).toBeNull()
    expect(storageWarning(5e9, 0)).toBeNull()
  })
})

describe('decodeWarning', () => {
  it('is silent when the decoder copes or the size is unknown', () => {
    expect(decodeWarning(true, 2160)).toBeNull()
    expect(decodeWarning(false, 0)).toBeNull()
  })

  it('names the resolution when it will lag', () => {
    expect(decodeWarning(false, 2160)).toMatch(/2160p/)
  })
})

describe('batteryWarning', () => {
  it('is silent when charging, healthy, or unknown', () => {
    expect(batteryWarning(0.1, true)).toBeNull()
    expect(batteryWarning(0.8, false)).toBeNull()
    expect(batteryWarning(-1, false)).toBeNull()
  })

  it('warns when low and discharging, with the percentage', () => {
    expect(batteryWarning(0.22, false)).toMatch(/22%/)
  })
})
