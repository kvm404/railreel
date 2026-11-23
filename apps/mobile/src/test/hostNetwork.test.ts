import { describe, it, expect } from 'vitest'
import {
  classifyCandidate,
  inviteStatus,
  pickHostNetwork,
  readHostNetwork,
  sameHostNetwork,
  type NetworkCandidate,
} from '@/lib/net/hostNetwork'

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

const c = (iface: string, ip: string, transport: NetworkCandidate['transport']): NetworkCandidate => ({ iface, ip, transport })

describe('host network selection', () => {
  it('prefers the SoftAP interface over the Wi-Fi station and cellular (Pixel: wlan1 hotspot)', () => {
    const net = pickHostNetwork([
      c('rmnet_data0', '10.120.4.7', 'cellular'),
      c('wlan0', '192.168.1.23', 'wifi'),
      c('wlan1', '10.211.88.1', 'none'),
    ])
    expect(net).toEqual({ ip: '10.211.88.1', kind: 'hotspot', iface: 'wlan1' })
  })

  it('recognises vendor SoftAP names and the legacy hotspot subnet', () => {
    expect(classifyCandidate(c('swlan0', '192.168.200.1', 'none'))).toBe('hotspot')
    expect(classifyCandidate(c('ap0', '192.168.44.1', 'none'))).toBe('hotspot')
    expect(classifyCandidate(c('eth9', '192.168.43.1', 'none'))).toBe('hotspot')
    expect(classifyCandidate(c('softap0', '192.168.5.1', 'other'))).toBe('hotspot')
  })

  it('falls back to the Wi-Fi station when there is no hotspot', () => {
    expect(pickHostNetwork([c('rmnet0', '100.64.1.2', 'cellular'), c('wlan0', '192.168.1.23', 'wifi')])).toEqual({
      ip: '192.168.1.23',
      kind: 'wifi',
      iface: 'wlan0',
    })
  })

  it('never offers cellular, VPN, 464xlat, link-local or loopback addresses', () => {
    expect(
      pickHostNetwork([
        c('rmnet_data1', '10.0.0.5', 'cellular'),
        c('tun0', '10.8.0.2', 'vpn'),
        c('v4-rmnet_data0', '192.0.0.4', 'none'),
        c('wlan0', '169.254.10.2', 'none'),
        c('lo', '127.0.0.1', 'none'),
        c('ccmni1', '10.1.1.1', 'other'),
      ]),
    ).toBeNull()
  })

  it('an unowned non-wlan interface is a usable "other" link (USB tether, ethernet adapter)', () => {
    expect(pickHostNetwork([c('rndis0', '192.168.42.129', 'none')])).toEqual({ ip: '192.168.42.129', kind: 'other', iface: 'rndis0' })
    expect(classifyCandidate(c('eth0', '192.168.0.9', 'ethernet'))).toBe('other')
  })

  it('prefers a private address within the same kind, and ignores malformed entries', () => {
    const net = pickHostNetwork([
      { iface: 'wlan2', ip: 'not-an-ip', transport: 'none' },
      c('wlan2', '203.0.113.9', 'none'),
      c('wlan1', '192.168.50.1', 'none'),
    ])
    expect(net?.ip).toBe('192.168.50.1')
    expect(pickHostNetwork([])).toBeNull()
  })

  it('compares networks by ip, kind and interface', () => {
    const a = { ip: '10.0.0.1', kind: 'hotspot' as const, iface: 'wlan1' }
    expect(sameHostNetwork(a, { ...a })).toBe(true)
    expect(sameHostNetwork(a, { ...a, kind: 'wifi' })).toBe(false)
    expect(sameHostNetwork(null, null)).toBe(true)
    expect(sameHostNetwork(a, null)).toBe(false)
  })
})
