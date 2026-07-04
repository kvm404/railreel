import { describe, it, expect } from 'vitest'
import { reconnectDelayMs } from '@/lib/net/backoff'

describe('reconnectDelayMs', () => {
  it('grows exponentially from the base', () => {
    expect(reconnectDelayMs(0)).toBe(500)
    expect(reconnectDelayMs(1)).toBe(1000)
    expect(reconnectDelayMs(2)).toBe(2000)
    expect(reconnectDelayMs(3)).toBe(4000)
  })

  it('caps at maxMs', () => {
    expect(reconnectDelayMs(4)).toBe(8000)
    expect(reconnectDelayMs(99)).toBe(8000)
  })

  it('treats negative attempts as the first attempt', () => {
    expect(reconnectDelayMs(-3)).toBe(500)
  })

  it('honors custom base/max', () => {
    expect(reconnectDelayMs(0, 1000, 5000)).toBe(1000)
    expect(reconnectDelayMs(10, 1000, 5000)).toBe(5000)
  })
})
