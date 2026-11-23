import { describe, it, expect } from 'vitest'
import { atmosphereIntensity, retainsOutgoing, stagedAtmosphere } from '@/lib/nav/transition'

describe('atmosphere by route', () => {
  it('runs the window everywhere but behind the opaque Player', () => {
    for (const r of ['Home', 'CreateSession', 'JoinSession', 'Lobby']) expect(atmosphereIntensity(r)).toBeGreaterThan(0)
    expect(atmosphereIntensity('Player')).toBe(0)
  })

  it('keeps the window up while the Lobby fades out under an arriving Player', () => {
    expect(stagedAtmosphere('Player', 'Lobby')).toBeGreaterThan(0)
    expect(stagedAtmosphere('Player', null)).toBe(0) // settled: off
  })

  it('brings the window straight back when leaving the Player', () => {
    expect(stagedAtmosphere('Lobby', null)).toBeGreaterThan(0)
  })
})

describe('retainsOutgoing', () => {
  it('keeps ordinary screens on stage for a push / pop / replace', () => {
    expect(retainsOutgoing('Home', false, 'step')).toBe(true)
    expect(retainsOutgoing('Lobby', false, 'step')).toBe(true)
  })
  it('swaps instantly under reduce-motion', () => {
    expect(retainsOutgoing('Home', true, 'step')).toBe(false)
  })
  it('never delays the Player unmount (it pauses the room)', () => {
    expect(retainsOutgoing('Player', false, 'step')).toBe(false)
  })
  it('unmounts the outgoing screen at once on a reset (session ending: its Modal sheet must go too)', () => {
    // e.g. the host ends the show while a guest's Lobby cleanup sheet is open → reset('Home')
    for (const r of ['Lobby', 'CreateSession', 'JoinSession', 'Home']) expect(retainsOutgoing(r, false, 'reset')).toBe(false)
  })
})
