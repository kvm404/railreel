import { useEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { Screen } from '@/components/Screen'
import { FilamentRing } from '@/components/FilamentRing'
import { Button, FlapText, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useNavigation } from '@/navigation/context'
import { canJoinShow, decideStartGate, type StartGateDecision } from '@/lib/sync/startGate'
import { targetPositionSec } from '@/lib/sync/playback'
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

  // A guest enters the show once the host has started it AND its own download covers the live
  // playhead (+lead). For the normal start (host paused at 0) that's immediate; for a LATE joiner
  // who arrives mid-movie, it waits in the lobby until it has buffered past the current position,
  // so it never lands on an un-downloaded frame and holds the room the moment it arrives.
  const { playback, hostNowMs, progress } = s
  const durationSec = s.movie?.durationSec ?? 0
  useEffect(() => {
    if (isHost || !playback) return
    const livePos = targetPositionSec(playback, hostNowMs())
    if (canJoinShow(progress, durationSec, livePos)) nav.navigate('Player')
  }, [isHost, playback, hostNowMs, progress, durationSec, nav])

  // Relabel the host's own entry to "You" on the host device (guests see "Host"); and show the
  // client's own ring from local download progress (smoother than the roster echo).
  const people: Participant[] = s.participants.map((p) => {
    if (isHost && p.id === 'host') return { ...p, name: 'You' }
    if (!isHost && p.name === 'You') return { ...p, progress: s.progress }
    return p
  })

  const aboard = people.filter((p) => p.status === 'ready').length
  const ready = people.length > 0 && people.every((p) => p.status === 'ready')

  // The progressive start gate (PRD §7): the show may start while downloads are still running,
  // as long as everyone has a head start and the math says their download outruns playback.
  const { participants, movie } = s
  const gate: StartGateDecision | null = useMemo(
    () =>
      isHost && movie
        ? decideStartGate(
            participants
              .filter((p) => p.id !== 'host')
              .map((p) => ({ id: p.id, name: p.name, progress: p.progress, downloadMbps: p.downloadMbps, positionSec: 0 })),
            { sizeBytes: movie.sizeBytes, durationSec: movie.durationSec, precacheOnly: !movie.fastStart },
          )
        : null,
    [isHost, movie, participants],
  )
  const canStart = gate?.start ?? false

  const startShow = () => {
    if (!isHost) return
    // Open the player for everyone PAUSED at the top — guests follow into the Player when they
    // receive this state, and have time to load before anything plays. The host then presses Play
    // to actually start the show in sync (so it never auto-plays while a guest is still buffering).
    s.setHostPlayback(0, false, 1)
    nav.navigate('Player')
  }

  // Backing out of the lobby is LEAVING the session — the host ends it for everyone (it is the
  // session's lifeline), a guest disconnects cleanly. Without this, a zombie download/socket
  // survives into the next session and poisons its start-gate math.
  const exitSession = () => {
    s.leave()
    nav.navigate('Home')
  }

  return (
    <Screen title="LOBBY" scroll onBack={exitSession}>
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
                {p.decodeOk === false ? (
                  <Text variant="data" tone="amber" style={{ marginTop: 2 }}>
                    ⚠ may lag — decoder
                  </Text>
                ) : null}
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

        {/* preflight cautions: honest, in-world, above the fold of the main action */}
        {(isHost ? s.hostWarning : (s.decodeCaution ?? s.error)) ? (
          <Text variant="caption" tone="amber" style={{ textAlign: 'center', marginBottom: 10 }}>
            {isHost ? s.hostWarning : (s.decodeCaution ?? s.error)}
          </Text>
        ) : null}

        {isHost ? (
          <Button
            title={canStart ? 'Start the show' : gate?.mode === 'precache' ? 'Pre-caching…' : 'Building head starts…'}
            subtitle={
              canStart
                ? ready
                  ? 'Lights down — everyone in sync'
                  : 'Head starts locked — downloads finish during the show'
                : gateEta(gate)
            }
            intent="amber"
            height={72}
            disabled={!canStart}
            onPress={startShow}
          />
        ) : (
          <Button
            title={
              playback // the show is already running and we're not in it yet → catching up
                ? 'Catching up to the show…'
                : s.clientPhase === 'ready'
                  ? 'Ready — waiting for host'
                  : s.clientPhase === 'denied'
                    ? 'Not approved'
                    : 'Getting ready…'
            }
            intent="cyan"
            height={72}
            disabled
          />
        )}
      </View>
    </Screen>
  )
}

/** "Waiting on Asha, Ben — ~3 min" (or seconds while a head start fills). */
function gateEta(gate: StartGateDecision | null): string | undefined {
  if (!gate || gate.waitingOn.length === 0) return undefined
  const names = gate.waitingOn.join(', ')
  if (gate.etaSec == null) return `Waiting on ${names}`
  const eta = gate.etaSec < 90 ? `~${gate.etaSec}s` : `~${Math.ceil(gate.etaSec / 60)} min`
  return `Waiting on ${names} — ${eta}`
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
