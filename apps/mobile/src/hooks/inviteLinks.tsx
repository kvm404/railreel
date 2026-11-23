import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Linking } from 'react-native'
import { parseInvite, type Invite } from '@/lib/links/invite'
import { useNavigation, type NavParams, type RouteName } from '@/navigation/context'
import { useSession } from '@/session/SessionProvider'

/**
 * Deep links. A tapped `railreel://join?...` invite (cold start via the initial URL, or while the
 * app is running via the `url` event) is validated with the protocol decoder and parked here until
 * the navigator can open Join with it prefilled — the guest then only types a name. An invite
 * never hijacks a live session: while hosting/joined it is dropped.
 */

type InviteLinks = {
  /** The newest validated invite not yet opened. */
  pending: Invite | null
  consume: () => void
}

const InviteLinkContext = createContext<InviteLinks>({ pending: null, consume: () => {} })

export function InviteLinkProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Invite | null>(null)

  useEffect(() => {
    let alive = true
    Linking.getInitialURL()
      .then((url) => {
        const invite = parseInvite(url)
        if (alive && invite) setPending(invite)
      })
      .catch(() => {})
    const sub = Linking.addEventListener('url', ({ url }) => {
      const invite = parseInvite(url)
      if (invite) setPending(invite)
    })
    return () => {
      alive = false
      sub.remove()
    }
  }, [])

  const consume = useCallback(() => setPending(null), [])
  const value = useMemo(() => ({ pending, consume }), [pending, consume])
  return <InviteLinkContext.Provider value={value}>{children}</InviteLinkContext.Provider>
}

export function useInviteLinks(): InviteLinks {
  return useContext(InviteLinkContext)
}

/** Route param carrying the validated invite URL into JoinSession. */
export const INVITE_PARAM = 'invite'

/**
 * Mounted under every route (via `withInviteBridge`): opens Join for a pending invite from the
 * screens where that is safe (Home, an unstarted Create), and drops it everywhere a live session
 * is in progress. JoinSession consumes invites itself (it is already the destination).
 */
function InviteBridge({ route }: { route: RouteName }) {
  const { pending, consume } = useInviteLinks()
  const nav = useNavigation()
  const s = useSession()
  const sessionBusy = s.role !== 'none' || s.hostPhase !== 'idle' || s.clientPhase !== 'idle'

  useEffect(() => {
    if (!pending || route === 'JoinSession') return
    if (sessionBusy || route === 'Lobby' || route === 'Player') {
      consume()
      return
    }
    // The end-of-session card owns the screen until it is dismissed; the invite waits behind it.
    if (s.sessionEnd) return
    const params: NavParams = { [INVITE_PARAM]: pending.url }
    const open = () => (route === 'Home' ? nav.navigate('JoinSession', params) : nav.replace('JoinSession', params))
    // A navigation can be swallowed mid-transition (a cold start lands during Home's entrance), so
    // keep trying until this screen unmounts — i.e. the push actually happened.
    open()
    const id = setInterval(open, 300)
    return () => clearInterval(id)
  }, [pending, route, sessionBusy, s.sessionEnd, nav, consume])

  return null
}

/** Wrap a route component so it hosts the invite bridge. */
export function withInviteBridge(route: RouteName, Screen: ComponentType<{ params?: NavParams }>): ComponentType<{ params?: NavParams }> {
  function WithBridge(props: { params?: NavParams }) {
    return (
      <>
        <Screen {...props} />
        <InviteBridge route={route} />
      </>
    )
  }
  WithBridge.displayName = `WithInviteBridge(${route})`
  return WithBridge
}
