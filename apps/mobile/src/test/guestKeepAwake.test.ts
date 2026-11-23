import { describe, it, expect } from 'vitest'
import { guestShouldStayAwake, type GuestAwakeInput } from '@/lib/session/keepAwake'

const guest = (over: Partial<GuestAwakeInput> = {}): GuestAwakeInput => ({
  role: 'client',
  clientPhase: 'ready',
  appState: 'active',
  ...over,
})

describe('guestShouldStayAwake', () => {
  it('holds the screen through the whole foreground guest session', () => {
    for (const clientPhase of ['requested', 'approved', 'downloading', 'ready'] as const) {
      expect(guestShouldStayAwake(guest({ clientPhase }))).toBe(true)
    }
    expect(guestShouldStayAwake(guest({ appState: 'unknown' }))).toBe(true)
  })

  it('releases on background', () => {
    expect(guestShouldStayAwake(guest({ appState: 'background' }))).toBe(false)
    expect(guestShouldStayAwake(guest({ appState: 'inactive' }))).toBe(false)
  })

  it('releases on denial, leave and session end', () => {
    expect(guestShouldStayAwake(guest({ clientPhase: 'denied' }))).toBe(false)
    expect(guestShouldStayAwake(guest({ role: 'none', clientPhase: 'idle' }))).toBe(false)
    expect(guestShouldStayAwake(guest({ role: 'none' }))).toBe(false)
  })

  it('never applies to the host (it holds its own tag)', () => {
    expect(guestShouldStayAwake(guest({ role: 'host' }))).toBe(false)
  })
})
