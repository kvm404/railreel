import { describe, it, expect } from 'vitest'
import { shouldPublishHostExit, type HostExitInput } from '@/lib/player/exit'

const live: HostExitInput = { leftSession: false, role: 'host', joinCode: 'ABCD-1234', mountedJoinCode: 'ABCD-1234' }

describe('shouldPublishHostExit', () => {
  it('pauses the room when the host steps back to the lobby of the same session', () => {
    expect(shouldPublishHostExit(live)).toBe(true)
  })
  it('stays silent after this Player left the session itself', () => {
    expect(shouldPublishHostExit({ ...live, leftSession: true })).toBe(false)
  })
  it('stays silent once the session ended or the role changed', () => {
    expect(shouldPublishHostExit({ ...live, role: 'none' })).toBe(false)
    expect(shouldPublishHostExit({ ...live, role: 'client' })).toBe(false)
  })
  it('never stamps a state onto a newer session', () => {
    expect(shouldPublishHostExit({ ...live, joinCode: 'WXYZ-9876' })).toBe(false)
    expect(shouldPublishHostExit({ ...live, joinCode: null, mountedJoinCode: null })).toBe(false)
  })
})
