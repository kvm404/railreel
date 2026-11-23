/**
 * The host's invite network (pure + unit-tested), in two halves:
 *
 * 1. SELECTION — which of this phone's addresses goes into the invite. A host phone usually has
 *    several IPv4 addresses at once: the hotspot (SoftAP) interface guests join, the Wi-Fi it may
 *    itself be a client of, cellular, maybe a VPN. Only the first two are reachable from guests,
 *    and only the hotspot is the one RailReel is built around. Android lists every network the
 *    phone USES in ConnectivityManager — the SoftAP is not one of them — so "a wlan-type
 *    interface no network owns" is the hotspot; the interface of a Wi-Fi network is the station
 *    link. The native module only lists what the OS reports (RailReelHost.getNetworkCandidates).
 *
 * 2. COPY — what the invite can honestly claim about that network. A reachable IPv4 address is
 *    NOT proof the hotspot is on — it may be ordinary WiFi (or another interface). So the copy
 *    says "invite ready on this network" unless selection really found a hotspot.
 */

export type HostNetworkKind = 'hotspot' | 'wifi' | 'other'
/** The address the invite carries, and what kind of link it is. `iface` is set by the store. */
export type HostNetwork = { ip: string; kind: HostNetworkKind; iface?: string }

// ── selection ─────────────────────────────────────────────────────────────────

/** One IPv4 address on one interface, as the native side reports it. */
export type NetworkCandidate = {
  /** Interface name (wlan0, wlan1, swlan0, ap0, rmnet_data0, tun0…). */
  iface: string
  ip: string
  /**
   * Transport of the ConnectivityManager network that owns this interface, or 'none' when no
   * network does (tethering/SoftAP interfaces are never networks the phone uses).
   */
  transport: 'wifi' | 'cellular' | 'vpn' | 'ethernet' | 'other' | 'none'
}

/** Interfaces Android uses for a SoftAP / Wi-Fi link (vendor names vary). */
const WLAN_IFACE = /^(wlan|swlan|ap|softap|wigig|tether)/i
/** SoftAP-only names: a hotspot even when ownership can't be read. */
const AP_IFACE = /^(swlan|ap|softap|tether)/i
/** Never reachable by a guest: cellular data, VPN tunnels, 464xlat stacks, dummies. */
const UNREACHABLE_IFACE = /^(rmnet|ccmni|v4-|clat|tun|ppp|dummy|ip6tnl|ip6gre|sit|seth|pdp|lo)/i

const isIpv4 = (ip: string): boolean => {
  const parts = ip.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** RFC 1918 private ranges — what a hotspot/LAN hands out. */
function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Unusable for an invite: unspecified, loopback, link-local, 192.0.0.0/24 (464xlat), multicast. */
function isUnusable(ip: string): boolean {
  if (!isIpv4(ip)) return true
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number]
  return a === 0 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 0 && c === 0) || a >= 224
}

/** The link kind of one candidate, or null when guests could never reach it. */
export function classifyCandidate(c: NetworkCandidate): HostNetworkKind | null {
  if (isUnusable(c.ip)) return null
  if (c.transport === 'cellular' || c.transport === 'vpn' || UNREACHABLE_IFACE.test(c.iface)) return null
  if (c.transport === 'wifi') return 'wifi'
  if (c.transport === 'none') {
    if (WLAN_IFACE.test(c.iface)) return 'hotspot'
    if (c.ip.startsWith('192.168.43.')) return 'hotspot' // legacy Android SoftAP subnet
  }
  // Ownership unreadable ('other'): trust SoftAP-only names; a bare wlan is most likely a station.
  if (c.transport === 'other' && AP_IFACE.test(c.iface)) return 'hotspot'
  return 'other'
}

const RANK: Record<HostNetworkKind, number> = { hotspot: 0, wifi: 1, other: 2 }

/** Best invite address: hotspot over Wi-Fi over anything else; private ranges first; stable. */
export function pickHostNetwork(candidates: readonly NetworkCandidate[]): HostNetwork | null {
  let best: { net: HostNetwork; score: number } | null = null
  for (const c of candidates) {
    if (!c || typeof c.ip !== 'string' || typeof c.iface !== 'string') continue
    const kind = classifyCandidate(c)
    if (!kind) continue
    const score = RANK[kind] * 2 + (isPrivate(c.ip) ? 0 : 1)
    if (!best || score < best.score) best = { net: { ip: c.ip, kind, iface: c.iface }, score }
  }
  return best?.net ?? null
}

export function sameHostNetwork(a: HostNetwork | null, b: HostNetwork | null): boolean {
  if (a === null || b === null) return a === b
  return a.ip === b.ip && a.kind === b.kind && (a.iface ?? '') === (b.iface ?? '')
}

// ── copy ──────────────────────────────────────────────────────────────────────

/**
 * Read the store's `hostNetwork` without a cast. Parsed defensively so a missing or malformed
 * value degrades to "unknown" (null) and the generic copy applies.
 */
export function readHostNetwork(store: object): HostNetwork | null {
  if (!('hostNetwork' in store)) return null
  const v = store.hostNetwork
  if (typeof v !== 'object' || v === null) return null
  if (!('ip' in v) || !('kind' in v)) return null
  const { ip, kind } = v
  if (typeof ip !== 'string' || ip.length === 0) return null
  if (kind === 'hotspot' || kind === 'wifi' || kind === 'other') return { ip, kind }
  return null
}

export type InviteStatus = {
  /** Step 1 is complete: guests can be given a link. */
  ready: boolean
  title: string
  body: string
}

/** Step-1 copy for the host's setup list. The Refresh action is available in EVERY state. */
export function inviteStatus(hasInvite: boolean, network: HostNetwork | null): InviteStatus {
  if (!hasInvite) {
    return {
      ready: false,
      title: 'Turn on your hotspot',
      body: 'No reachable address yet. Turn on your hotspot, then tap Refresh link to show the invite.',
    }
  }
  if (network?.kind === 'hotspot') {
    return {
      ready: true,
      title: 'Hotspot is on',
      body: 'Keep it on for the whole movie. Name it so friends recognize it.',
    }
  }
  if (network?.kind === 'wifi') {
    return {
      ready: true,
      title: 'Invite ready on your WiFi',
      body: "Friends must be on this same WiFi. If they can't see your cabin, turn on your hotspot and tap Refresh link.",
    }
  }
  return {
    ready: true,
    title: 'Invite ready on this network',
    body: "If friends can't see your cabin, turn on your hotspot and tap Refresh link.",
  }
}
