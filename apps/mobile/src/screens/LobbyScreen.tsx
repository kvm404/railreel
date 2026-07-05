import { useEffect, useMemo, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'
import { Check, X, DoorClosed } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { FilamentBar } from '@/components/FilamentBar'
import { StatusScreen } from '@/components/StatusScreen'
import { Button, FlapText, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useNavigation } from '@/navigation/context'
import { canJoinShow, decideStartGate, departureClock, type StartGateDecision } from '@/lib/sync/startGate'
import { targetPositionSec } from '@/lib/sync/playback'
import { useSession, type Participant } from '@/session/SessionProvider'

/**
 * The Boarding Board — the download-wait made the signature moment (docs/design-language.md).
 *
 * A split-flap departure board: the destination (movie), a big DEPARTS IN countdown that flips
 * toward ALL ABOARD, and a passenger manifest where each friend's download burns across a
 * tungsten filament with live speed. The host approves boarders and starts the show; anyone can
 * leave the platform.
 */

export function LobbyScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const isHost = s.role === 'host'
  const title = s.movie?.title ?? 'The show'

  // A guest enters the show once the host has started it AND its own download covers the live
  // playhead (+lead) — for a late joiner mid-movie, it waits here until buffered past that point.
  const { playback, hostNowMs, progress, movie } = s
  const durationSec = movie?.durationSec ?? 0
  useEffect(() => {
    if (isHost || !playback) return
    const livePos = targetPositionSec(playback, hostNowMs())
    if (canJoinShow(progress, durationSec, livePos)) nav.navigate('Player')
  }, [isHost, playback, hostNowMs, progress, durationSec, nav])

  // Relabel the host's own entry to "You"; show our own ring from local progress (smoother echo).
  const people: Participant[] = s.participants.map((p) => {
    if (isHost && p.id === 'host') return { ...p, name: 'You' }
    if (!isHost && p.name === 'You') return { ...p, progress: s.progress }
    return p
  })
  const guests = people.filter((p) => p.id !== 'host')
  const aboard = people.filter((p) => p.status === 'ready').length

  // The progressive start gate (PRD §7), computed on BOTH roles from the shared roster + media —
  // so the departure clock reads the same on every phone.
  const gate: StartGateDecision | null = useMemo(
    () =>
      movie
        ? decideStartGate(
            guests.map((p) => ({ id: p.id, name: p.name, progress: p.progress, downloadMbps: p.downloadMbps, positionSec: 0 })),
            { sizeBytes: movie.sizeBytes, durationSec: movie.durationSec, precacheOnly: !movie.fastStart },
          )
        : null,
    [movie, guests],
  )
  const readyToDepart = gate?.start ?? false

  const startShow = () => {
    if (!isHost) return
    // Open the player for everyone PAUSED at the top; the host then presses Play to roll in sync.
    s.setHostPlayback(0, false, 1)
    nav.navigate('Player')
  }

  // Backing out / leaving is a clean teardown so no zombie session poisons the next one.
  const exitSession = () => {
    s.leave()
    nav.navigate('Home')
  }

  // The host said no — a designed dead-end, not a stuck lobby.
  if (s.clientPhase === 'denied') {
    return (
      <StatusScreen
        icon={<DoorClosed size={44} color={t.palette.cyan} strokeWidth={1.75} />}
        tone="cyan"
        eyebrow="NOT THIS TIME"
        headline="The host didn't let you in"
        body="Only the host can approve who boards. Ask them to try again, or find another cabin."
        primary={{ label: 'Back to the platform', onPress: exitSession }}
      />
    )
  }

  const sizeLabel = movie ? fmtSize(movie.sizeBytes) : ''
  // A failed download drops us back to 'approved' with an error — offer a retry (grant still valid).
  const downloadFailed = !isHost && s.clientPhase === 'approved' && !!s.error
  const preflight = isHost ? s.hostWarning : (s.decodeCaution ?? s.error)

  return (
    <Screen title="LOBBY" scroll onBack={exitSession}>
      <View style={styles.body}>
        {/* ── the board ─────────────────────────────────────────────────────── */}
        <View style={[styles.board, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <Text variant="eyebrow" tone="tertiary">
            NIGHT TRAIN
          </Text>
          <Text variant="title" numberOfLines={1} style={{ marginTop: 4 }}>
            {title}
          </Text>
          <Text variant="data" tone="tertiary" style={{ marginTop: 2 }}>
            {[sizeLabel, `${aboard}/${people.length} ABOARD`].filter(Boolean).join('  ·  ')}
          </Text>

          <View style={styles.clock}>
            <Text variant="eyebrow" tone={readyToDepart ? 'amber' : 'secondary'} style={{ marginBottom: 10 }}>
              {readyToDepart ? 'READY TO DEPART' : 'DEPARTS IN'}
            </Text>
            {readyToDepart ? (
              <Ignition>
                <FlapText value="ALL ABOARD" size={30} tone="amber" stagger={55} />
              </Ignition>
            ) : (
              <FlapText value={departureClock(gate?.etaSec ?? null)} size={52} tone="primary" stagger={0} haptics={false} />
            )}
            {!readyToDepart && gate?.waitingOn.length ? (
              <Text variant="data" tone="tertiary" style={{ marginTop: 10, textAlign: 'center' }}>
                waiting on {gate.waitingOn.join(', ')}
              </Text>
            ) : null}
          </View>
        </View>

        {/* ── the manifest ──────────────────────────────────────────────────── */}
        <Text variant="eyebrow" tone="tertiary" style={{ marginTop: 4 }}>
          MANIFEST
        </Text>
        <View style={styles.manifest}>
          {people.map((p) => (
            <ManifestRow
              key={p.id}
              person={p}
              isHost={isHost}
              onApprove={() => s.approve(p.id)}
              onDeny={() => s.deny(p.id)}
            />
          ))}
        </View>

        <View style={{ flex: 1, minHeight: 8 }} />

        {preflight ? (
          <Text variant="caption" tone="amber" style={styles.warn}>
            {preflight}
          </Text>
        ) : null}

        {isHost ? (
          <Button
            title={readyToDepart ? 'Start the show' : gate?.mode === 'precache' ? 'Pre-caching…' : 'Building head starts…'}
            subtitle={
              readyToDepart
                ? aboard === people.length
                  ? 'Lights down — everyone in sync'
                  : 'Head starts locked — downloads finish during the show'
                : undefined
            }
            intent="amber"
            height={68}
            disabled={!readyToDepart}
            onPress={startShow}
          />
        ) : downloadFailed ? (
          <Button title="The reel snagged — try again" intent="amber" height={68} onPress={s.retryDownload} />
        ) : (
          <View style={[styles.status, { borderColor: t.palette.hairline }]}>
            <Text variant="cardTitle" tone="cyan">
              {playback
                ? 'Catching up to the show…'
                : readyToDepart
                  ? 'Ready — waiting for host'
                  : 'Boarding…'}
            </Text>
          </View>
        )}

        <Button title="Leave the platform" intent="cyan" height={48} onPress={exitSession} style={{ marginTop: 4 }} />
      </View>
    </Screen>
  )
}

/** One passenger: filament download, live speed, and an ABOARD flap — or the host's approve row. */
function ManifestRow({
  person,
  isHost,
  onApprove,
  onDeny,
}: {
  person: Participant
  isHost: boolean
  onApprove: () => void
  onDeny: () => void
}) {
  const t = useTheme()
  const p = person
  const requested = p.status === 'requested'
  const ready = p.status === 'ready'
  const pct = Math.round(p.progress * 100)

  return (
    <Animated.View entering={FadeIn.duration(240)} style={[styles.row, { borderColor: t.palette.hairline }]}>
      <View style={styles.rowHead}>
        <View style={[styles.dot, { backgroundColor: ready ? t.palette.amber : t.palette.textTertiary }]} />
        <Text variant="cardTitle" numberOfLines={1} style={styles.rowName}>
          {p.name}
        </Text>
        {ready ? (
          <FlapText value="ABOARD" size={13} tone="amber" stagger={30} />
        ) : requested ? (
          <Text variant="data" tone="cyan">
            wants in
          </Text>
        ) : (
          <Text variant="data" tone="tertiary">
            {pct}%{p.downloadMbps > 0.1 ? `  ↓${p.downloadMbps.toFixed(1)} Mb/s` : ''}
          </Text>
        )}
      </View>

      {requested && isHost ? (
        <View style={styles.approveRow}>
          <Button title="Approve" icon={<Check size={16} color={t.palette.onAmber} strokeWidth={2.5} />} intent="amber" height={40} onPress={onApprove} style={{ flex: 1 }} />
          <Button title="Deny" icon={<X size={16} color={t.palette.cyan} strokeWidth={2.5} />} intent="cyan" height={40} onPress={onDeny} style={{ flex: 1 }} />
        </View>
      ) : !requested ? (
        <View style={{ marginTop: 10 }}>
          <FilamentBar progress={ready ? 1 : p.progress} />
        </View>
      ) : null}

      {p.decodeOk === false ? (
        <Text variant="data" tone="amber" style={{ marginTop: 6 }}>
          ⚠ may lag — this phone can't decode smoothly
        </Text>
      ) : null}
    </Animated.View>
  )
}

/** The "everyone's ready" climax: a one-shot amber bloom + success haptic under the ALL ABOARD flap. */
function Ignition({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const glow = useSharedValue(0)
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
    if (!reduced) glow.value = withSequence(withTiming(0.6, { duration: 240 }), withTiming(0.16, { duration: 1100 }))
    else glow.value = 0.16
  }, [glow, reduced])

  const bloom = useAnimatedStyle(() => ({ opacity: glow.value }))
  return (
    <View style={styles.ignite}>
      <Animated.View pointerEvents="none" style={[styles.bloom, { backgroundColor: t.palette.amber }, bloom]} />
      {children}
    </View>
  )
}

function fmtSize(bytes: number): string {
  if (!(bytes > 0)) return ''
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 14, paddingTop: 4 },
  board: { borderWidth: 1, borderRadius: 20, padding: 18 },
  clock: { alignItems: 'center', marginTop: 22, marginBottom: 6 },
  ignite: { alignItems: 'center', justifyContent: 'center' },
  bloom: {
    position: 'absolute',
    width: 260,
    height: 90,
    borderRadius: 999,
    transform: [{ scaleX: 1.4 }],
  },
  manifest: { gap: 10 },
  row: { borderWidth: 1, borderRadius: 16, padding: 14 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowName: { flex: 1 },
  approveRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  warn: { textAlign: 'center', marginBottom: 4 },
  status: { borderWidth: 1, borderRadius: 24, minHeight: 68, alignItems: 'center', justifyContent: 'center' },
})
