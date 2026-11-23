import { describe, it, expect } from 'vitest'
import { fmtTime, spokenTime } from '@/lib/player/time'

describe('fmtTime', () => {
  it('formats short and long positions', () => {
    expect(fmtTime(0)).toBe('0:00')
    expect(fmtTime(65.9)).toBe('1:05')
    expect(fmtTime(3600)).toBe('1:00:00')
    expect(fmtTime(2 * 3600 + 5 * 60 + 7)).toBe('2:05:07')
  })

  it('treats junk as zero', () => {
    expect(fmtTime(NaN)).toBe('0:00')
    expect(fmtTime(-4)).toBe('0:00')
  })
})

describe('spokenTime', () => {
  it('speaks hours and minutes', () => {
    expect(spokenTime(59)).toBe('0 minutes')
    expect(spokenTime(61)).toBe('1 minute')
    expect(spokenTime(3600 + 120)).toBe('1 hour 2 minutes')
  })
})
