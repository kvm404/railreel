import { describe, it, expect } from 'vitest'
import { END_EPSILON_SEC, playPressPlan } from '@/lib/player/transport'

describe('playPressPlan', () => {
  it('restarts from the top after The End, whatever the player reports', () => {
    expect(playPressPlan({ ended: true, positionSec: 5400, durationSec: 5400 })).toEqual({ restart: true, fromSec: 0 })
    // the native seek is async: a stale position must never be published as the restart point
    expect(playPressPlan({ ended: true, positionSec: 5399.2, durationSec: 0 })).toEqual({ restart: true, fromSec: 0 })
  })

  it('treats a playhead parked at the end as ended (no playToEnd yet)', () => {
    expect(playPressPlan({ ended: false, positionSec: 5400 - END_EPSILON_SEC / 2, durationSec: 5400 }).restart).toBe(true)
  })

  it('plays on from the current position otherwise', () => {
    expect(playPressPlan({ ended: false, positionSec: 61.5, durationSec: 5400 })).toEqual({ restart: false, fromSec: 61.5 })
    expect(playPressPlan({ ended: false, positionSec: 10, durationSec: 0 })).toEqual({ restart: false, fromSec: 10 })
  })

  it('sanitises a bad position', () => {
    expect(playPressPlan({ ended: false, positionSec: Number.NaN, durationSec: 5400 })).toEqual({ restart: false, fromSec: 0 })
    expect(playPressPlan({ ended: false, positionSec: -3, durationSec: 5400 })).toEqual({ restart: false, fromSec: 0 })
  })
})
