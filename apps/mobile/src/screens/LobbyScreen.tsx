import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { Screen } from '@/components/Screen'
import { FilamentRing } from '@/components/FilamentRing'
import { Button, FlapText, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useNavigation } from '@/navigation/context'
import { useSession, type Participant } from '@/session/SessionProvider'

/**
 * The lobby: each friend's download readiness as a filament ring, fed by the real transfer layer.
 * The host approves join requests here; the board flips to READY and Start ignites once everyone's
 * aboard. See docs/design-language.md.
 */

export function LobbyScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const isHost = s.role === 'host'
  const title = s.movie?.title ?? 'The show'

  // A guest is taken into the show the moment the host starts it.
  useEffect(() => {
    if (!isHost && s.playback) nav.navigate('Player')
  }, [isHost, s.playback, nav])

  // Relabel the host's own entry to "You" on the host device (guests see "Host"); and show the
  // client's own ring from local download progress (smoother than the roster echo).
  const people: Participant[] = s.participants.map((p) => {
    if (isHost && p.id === 'host') return { ...p, name: 'You' }
    if (!isHost && p.name === 'You') return { ...p, progress: s.progress }
    return p
  })

  const aboard = people.filter((p) => p.status === 'ready').length
  const ready = people.length > 0 && people.every((p) => p.status === 'ready')

  const startShow = () => {
    if (!isHost) return
    // Broadcast "playing from the top" (stamped with the host clock) and open the player; guests
    // follow into the Player via the effect above when they receive this state.
    s.setHostPlayback(0, true, 1)
    nav.navigate('Player')
  }

  return (
    <Screen title="LOBBY" scroll>
      <View style={styles.body}>
        <View style={styles.head}>
          <Text variant="title" numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.count}>
            <FlapText value={ready ? 'READY' : `${aboard}/${people.length}`} size={22} tone={ready ? 'amber' : 'cyan'} stagger={40} />
            <Text variant="eyebrow" tone="tertiary" style={{ marginTop: 6 }}>
              {ready ? 'EVERYONE ABOARD' : 'ABOARD'}
            </Text>
          </View>
        </View>

        <View style={styles.grid}>
          {people.map((p) => {
            const requested = p.status === 'requested'
            return (
              <View key={p.id} style={[styles.person, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
                <FilamentRing progress={p.status === 'ready' ? 1 : p.progress} size={84} />
                <Text variant="cardTitle" numberOfLines={1} style={{ marginTop: 10 }}>
                  {p.name}
                </Text>
                <Text variant="data" tone="tertiary">
                  {statusLabel(p)}
                </Text>
                {isHost && requested ? (
                  <View style={styles.approveRow}>
                    <Button title="Approve" intent="amber" height={40} onPress={() => s.approve(p.id)} />
                    <Button title="Deny" intent="cyan" height={40} onPress={() => s.deny(p.id)} />
                  </View>
                ) : null}
              </View>
            )
          })}
        </View>

        <View style={{ flex: 1 }} />

        {isHost ? (
          <Button
            title={ready ? 'Start the show' : 'Waiting for everyone…'}
            subtitle={ready ? 'Lights down — everyone in sync' : undefined}
            intent="amber"
            height={72}
            disabled={!ready}
            onPress={startShow}
          />
        ) : (
          <Button
            title={s.clientPhase === 'ready' ? 'Ready — waiting for host' : s.clientPhase === 'denied' ? 'Not approved' : 'Getting ready…'}
            intent="cyan"
            height={72}
            disabled
          />
        )}
      </View>
    </Screen>
  )
}

function statusLabel(p: Participant): string {
  switch (p.status) {
    case 'requested':
      return 'wants in'
    case 'approved':
      return 'approved'
    case 'ready':
      return 'ready'
    case 'downloading':
      return `${Math.round(p.progress * 100)}%`
    default:
      return `${Math.round(p.progress * 100)}%`
  }
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 18, paddingTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { alignItems: 'flex-end' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  person: {
    width: '47.5%',
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 20,
    borderWidth: 1,
    borderRadius: 18,
  },
  approveRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
})
