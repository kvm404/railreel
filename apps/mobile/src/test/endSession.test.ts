import { describe, it, expect } from 'vitest'
import { activeGuestCount, endSessionBody, needsEndConfirmation } from '@/lib/host/endSession'

describe('activeGuestCount', () => {
  it('counts everyone but the host and those who left', () => {
    const people = [
      { id: 'host', status: 'ready' },
      { id: 'a', status: 'requested' },
      { id: 'b', status: 'downloading' },
      { id: 'c', status: 'left' },
    ]
    expect(activeGuestCount(people)).toBe(2)
    expect(activeGuestCount([{ id: 'host', status: 'ready' }])).toBe(0)
  })
})

describe('needsEndConfirmation', () => {
  it('asks only for a live session with people aboard', () => {
    expect(needsEndConfirmation('live', 1)).toBe(true)
    expect(needsEndConfirmation('live', 0)).toBe(false)
    expect(needsEndConfirmation('starting', 2)).toBe(false)
    expect(needsEndConfirmation('idle', 2)).toBe(false)
  })
})

describe('endSessionBody', () => {
  it('names the consequence, singular and plural', () => {
    expect(endSessionBody(1)).toMatch(/the friend aboard/)
    expect(endSessionBody(3)).toMatch(/the 3 friends aboard/)
  })
})
