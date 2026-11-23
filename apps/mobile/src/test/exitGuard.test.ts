import { describe, expect, it } from 'vitest'
import { resumeExit } from '@/lib/nav/exitGuard'

describe('resumeExit', () => {
  it('tears down and leaves when nothing changed during the await', () => {
    expect(resumeExit({ mounted: true, sessionActive: true })).toBe('leave')
  })

  it('only navigates when the session ended meanwhile (keeps the end card)', () => {
    expect(resumeExit({ mounted: true, sessionActive: false })).toBe('reset')
  })

  it('does nothing once the screen is gone, so a newer session survives', () => {
    expect(resumeExit({ mounted: false, sessionActive: true })).toBe('skip')
    expect(resumeExit({ mounted: false, sessionActive: false })).toBe('skip')
  })
})
