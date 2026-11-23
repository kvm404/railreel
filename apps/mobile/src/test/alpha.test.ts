import { describe, it, expect } from 'vitest'
import { withAlpha } from '@/ui/alpha'

describe('withAlpha', () => {
  it('derives an rgba wash from a palette hex', () => {
    expect(withAlpha('#FFB25C', 0.16)).toBe('rgba(255,178,92,0.16)')
    expect(withAlpha('#05070c', 1)).toBe('rgba(5,7,12,1)')
  })

  it('clamps alpha and passes non-hex values through untouched', () => {
    expect(withAlpha('#000000', 2)).toBe('rgba(0,0,0,1)')
    expect(withAlpha('#000000', -1)).toBe('rgba(0,0,0,0)')
    expect(withAlpha('transparent', 0.5)).toBe('transparent')
  })
})
