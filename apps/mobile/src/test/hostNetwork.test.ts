import { describe, it, expect } from 'vitest'
import { inviteStatus, readHostNetwork } from '@/lib/net/hostNetwork'

describe('readHostNetwork', () => {
  it('is null while the store has no such field', () => {
    expect(readHostNetwork({ joinUrl: 'x' })).toBeNull()
  })

  it('reads a well-formed value', () => {
    expect(readHostNetwork({ hostNetwork: { ip: '192.168.43.1', kind: 'hotspot' } })).toEqual({ ip: '192.168.43.1', kind: 'hotspot' })
    expect(readHostNetwork({ hostNetwork: { ip: '10.0.0.4', kind: 'wifi' } })?.kind).toBe('wifi')
  })

  it('treats null, junk and unknown kinds as unknown', () => {
    expect(readHostNetwork({ hostNetwork: null })).toBeNull()
    expect(readHostNetwork({ hostNetwork: 'hotspot' })).toBeNull()
    expect(readHostNetwork({ hostNetwork: { ip: '', kind: 'wifi' } })).toBeNull()
    expect(readHostNetwork({ hostNetwork: { ip: '1.2.3.4', kind: 'cellular' } })).toBeNull()
    expect(readHostNetwork({ hostNetwork: { ip: '1.2.3.4' } })).toBeNull()
  })
})

describe('inviteStatus', () => {
  it('asks for the hotspot when there is no address', () => {
    const s = inviteStatus(false, null)
    expect(s.ready).toBe(false)
    expect(s.title).toBe('Turn on your hotspot')
  })

  it("never claims a hotspot just because an invite exists", () => {
    for (const net of [null, { ip: '1.2.3.4', kind: 'other' as const }]) {
      const s = inviteStatus(true, net)
      expect(s.ready).toBe(true)
      expect(s.title).toBe('Invite ready on this network')
      expect(s.title).not.toMatch(/hotspot is on/i)
      expect(s.body).toMatch(/turn on your hotspot/i)
    }
  })

  it('says hotspot only when the platform said so', () => {
    expect(inviteStatus(true, { ip: '192.168.43.1', kind: 'hotspot' }).title).toBe('Hotspot is on')
  })

  it('names plain WiFi honestly', () => {
    expect(inviteStatus(true, { ip: '192.168.1.5', kind: 'wifi' }).title).toMatch(/WiFi/)
  })
})
