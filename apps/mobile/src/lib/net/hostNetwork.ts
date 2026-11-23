/**
 * What the host's invite can honestly claim about the network it sits on. A reachable IPv4 address
 * is NOT proof the hotspot is on — it may be ordinary WiFi (or another interface). So the copy
 * says "invite ready on this network" unless the platform told us it really is a hotspot.
 * Pure + unit-tested.
 */

export type HostNetworkKind = 'hotspot' | 'wifi' | 'other'
export type HostNetwork = { ip: string; kind: HostNetworkKind }

/**
 * Read the store's optional `hostNetwork` without a cast. The field is added to the session store
 * separately from this UI; until it exists (or while it is unset) this returns null and the
 * generic copy applies. Parsed defensively so a malformed value degrades to "unknown".
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
