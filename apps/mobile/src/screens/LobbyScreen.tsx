import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  cancelAnimation,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { Check, X, DoorClosed } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { FilamentBar } from '@/components/FilamentBar'
import { FilamentBloom } from '@/components/FilamentBloom'
import { StatusScreen } from '@/components/StatusScreen'
import { CleanupSheet } from '@/components/CleanupSheet'
import { SyncDots } from '@/components/SyncDots'
import { Button, FlapText, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useBackHandler, useNavigation } from '@/navigation/context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { resumeExit } from '@/lib/nav/exitGuard'
import { describeCleanupFailure } from '@/lib/storage'
import { canJoinShow, decideStartGate, departureClock, type StartGateDecision } from '@/lib/sync/startGate'
import { targetPositionSec } from '@/lib/sync/playback'
import {
  boardPhase,
  bucketRoster,
  createMilestoneLatch,
  ignitionSchedule,
  type BoardPhase,
} from '@/lib/sync/readiness'
import { radii, sizes } from '@/theme/tokens'
import { useSession, type Participant } from '@/session/SessionProvider'

/**
 * The Boarding Board — the download-wait made the signature moment (docs/design-language.md).
 *
 * A split-flap departure board: the destination (movie), a big DEPARTS IN countdown that flips
 * toward ALL ABOARD, and a passenger manifest grouped by where each person actually is — WANTS IN
 * (asked, not approved), BOARDING (downloading) and READY TO DEPART. Every count comes from the
 * same eligible roster the start gate reads, so the board can never claim more than the gate does.
 * The host approves boarders and starts the show; anyone can leave the platform.
 */

/** Once-per-session milestones (the readiness climax plays and buzzes ONE time, not on every remount). */
const milestones = createMilestoneLatch()

export function LobbyScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const reduced = useReduceMotion()
  const isHost = s.role === 'host'
  const title = s.movie?.title ?? 'The show'

  // A guest enters the show once the host has started it AND its own download covers the live
  // playhead (+lead) — for a late joiner mid-movie, it waits here until buffered past that point.
  const { playback, hostNowMs, progress, movie, userLeftShow } = s
  const durationSec = movie?.durationSec ?? 0
  useEffect(() => {
    if (isHost || !playback || userLeftShow) return
    const livePos = targetPositionSec(playback, hostNowMs())
    if (canJoinShow(progress, durationSec, livePos)) nav.navigate('Player')
  }, [isHost, playback, hostNowMs, progress, durationSec, nav, userLeftShow])

  // Relabel the host's own entry to "You"; show our own ring from local progress (smoother echo).
  const people: Participant[] = useMemo(
    () =>
      s.participants.map((p) => {
        if (isHost && p.id === 'host') return { ...p, name: 'You' }
        if (!isHost && p.name === 'You') return { ...p, progress: s.progress }
        return p
      }),
    [s.participants, isHost, s.progress],
  )
  // ONE eligible roster feeds the headline counts, the board state and the start gate.
  const buckets = useMemo(() => bucketRoster(people), [people])
  const leftPeople = useMemo(() => people.filter((p) => p.status === 'left'), [people])

  // The progressive start gate (PRD §7), computed on BOTH roles from the shared roster + media —
  // so the departure clock reads the same on every phone.
  const gate: StartGateDecision | null = useMemo(
    () =>
      movie
        ? decideStartGate(
            buckets.gateRoster.map((p) => ({ id: p.id, name: p.name, status: p.status, progress: p.progress, downloadMbps: p.downloadMbps, positionSec: 0 })),
            { sizeBytes: movie.sizeBytes, durationSec: movie.durationSec, precacheOnly: !movie.fastStart },
          )
        : null,
    [movie, buckets],
  )
  const readyToDepart = gate?.start ?? false

  // A guest whose seat is still only a request must never be shown readiness (the roster can look
  // "all ready" from their side: just the host is aboard).
  const iAmRequested = !isHost && (s.clientPhase === 'requested' || people.some((p) => p.name === 'You' && p.status === 'requested'))
  const phase = boardPhase({ iAmRequested, buckets, gateStart: readyToDepart })

  // One coordinated readiness event: rows ignite in turn → board flips ALL ABOARD → amber bloom
  // (+ the single success haptic) → Start lights.
  const sessionKey = `${s.role}:${movie?.title ?? ''}:${movie?.sizeBytes ?? 0}`
  const seq = useReadinessSequence(phase === 'all-aboard', buckets.ready.length, sessionKey, reduced)
  useEffect(() => {
    if (s.role === 'none') milestones.reset()
  }, [s.role])
  const schedule = useMemo(() => ignitionSchedule(buckets.ready.length, reduced), [buckets.ready.length, reduced])
  const igniteDelays = useMemo(() => {
    const m = new Map<string, number>()
    buckets.ready.forEach((p, i) => m.set(p.id, schedule.rowDelaysMs[i] ?? 0))
    return m
  }, [buckets.ready, schedule])
  const shownPhase: BoardPhase = phase === 'all-aboard' && seq.stage < 2 ? 'ready-to-depart' : phase
  const startLit = readyToDepart && (phase !== 'all-aboard' || seq.stage >= 4)

  const resumePos = Number.isFinite(s.playback?.positionSec) && !s.playback?.ended ? Math.max(0, s.playback!.positionSec) : 0
  const isResuming = resumePos > 0

  const startShow = () => {
    if (!isHost) return
    // Open the player for everyone PAUSED at the resume position (or 0 if starting fresh);
    // the host then presses Play to roll in sync.
    s.setHostPlayback(resumePos, false, 1)
    nav.navigate('Player')
  }

  const [showCleanupSheet, setShowCleanupSheet] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Session torn down under us (host ended it, reconnect gave up): reset to Home, where the
  // store's sessionEnd shows as the designed end card — not an empty board. A denial keeps the
  // role, so its own dead-end screen below still renders.
  useEffect(() => {
    if (s.role === 'none' && s.clientPhase !== 'denied') nav.reset('Home')
  }, [s.role, s.clientPhase, nav])

  // Leaving is a clean teardown so no zombie session poisons the next one, and a stack reset so
  // Back from Home can't land on this dead board again.
  const exitSession = () => {
    s.leave()
    nav.reset('Home')
  }

  // Async exits resume only into the session they started from: if the host ended it meanwhile this
  // board has already reset Home and unmounted, and the user may be in a NEW session by the time a
  // slow purge settles — leave() then would tear that one down.
  const mounted = useMountedRef()
  const sessionRef = useRef(s)
  sessionRef.current = s
  const resumeExitSession = () => {
    const step = resumeExit({ mounted: mounted.current, sessionActive: sessionRef.current.role !== 'none' })
    if (step === 'leave') exitSession()
    else if (step === 'reset') nav.reset('Home')
  }

  const handleExitRequest = async () => {
    const info = await s.getCacheInfo()
    if (!mounted.current) return
    if (info.totalBytes > 0) {
      setDeleteError(null)
      setShowCleanupSheet(true)
    } else {
      resumeExitSession()
    }
  }

  // Leave only once the files are PROVABLY gone: purgeCache() swallows per-file errors, so verify
  // the remaining bytes ourselves and keep the sheet open with a retry when anything survived.
  const handleDeleteAndLeave = async () => {
    setIsDeleting(true)
    setDeleteError(null)
    let threw = false
    let remaining = 0
    try {
      await s.purgeCache()
    } catch {
      threw = true
    }
    try {
      remaining = (await s.getCacheInfo()).totalBytes
    } catch {
      threw = true
    }
    if (!mounted.current) return
    setIsDeleting(false)
    const failure = describeCleanupFailure(remaining, threw)
    if (failure) {
      setDeleteError(failure)
      return
    }
    setShowCleanupSheet(false)
    resumeExitSession()
  }

  const handleKeepAndLeave = () => {
    setShowCleanupSheet(false)
    exitSession()
  }

  // Back (header or hardware). A guest leaves through the cleanup prompt. The host steps back to
  // the invite screen with the session still live: one stray back gesture must not end the show
  // for the whole cabin ("Leave the platform" is the deliberate way out).
  const handleBack = () => {
    if (isHost && nav.canGoBack) nav.goBack()
    else void handleExitRequest()
  }

  // The denied dead-end has no header, so it claims hardware Back itself.
  useBackHandler(
    () => {
      exitSession()
      return true
    },
    { enabled: s.clientPhase === 'denied' },
  )

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

  // Fit the board's flaps to the card on narrow phones (cell ≈ 0.84×size, gap ≈ 0.1×size).
  const boardInner = width - sizes.gutter * 2 - insets.left - insets.right - 38
  const fitFlap = (chars: number, max: number) =>
    Math.max(16, Math.min(max, Math.floor(boardInner / (chars * 0.84 + (chars - 1) * 0.1))))

  const counts = [
    sizeLabel,
    phase === 'awaiting-approval' ? 'REQUESTED' : `${buckets.ready.length}/${buckets.eligible.length} ABOARD`,
    buckets.wantsIn.length > 0 && phase !== 'awaiting-approval' ? `${buckets.wantsIn.length} WANT IN` : '',
  ].filter(Boolean)

  const myPct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  const guestStatus = playback
    ? 'Catching up to the show…'
    : phase === 'awaiting-approval'
      ? 'Waiting for the host to let you in'
      : progress < 1
        ? `Boarding… ${myPct}%`
        : readyToDepart
          ? 'Ready — waiting for the host to start'
          : "You're ready — waiting for the others"

  const sections: { key: string; title: string; tone: 'amber' | 'muted'; people: Participant[] }[] = [
    { key: 'wants', title: 'WANTS IN', tone: 'amber', people: buckets.wantsIn },
    { key: 'boarding', title: 'BOARDING', tone: 'muted', people: buckets.boarding },
    { key: 'ready', title: 'READY TO DEPART', tone: 'muted', people: buckets.ready },
    { key: 'left', title: 'LEFT', tone: 'muted', people: leftPeople },
  ]

  return (
    <Screen title="LOBBY" scroll onBack={handleBack}>
      <View style={styles.body}>
        {/* ── the board ─────────────────────────────────────────────────────── */}
        <View style={[styles.board, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <Text variant="eyebrow" tone="muted">
            NIGHT TRAIN
          </Text>
          <Text variant="title" numberOfLines={1} style={{ marginTop: 4 }}>
            {title}
          </Text>
          <Text variant="data" tone="muted" style={{ marginTop: 2 }}>
            {counts.join('  ·  ')}
          </Text>

          <View style={styles.clock}>
            <BoardFace
              phase={shownPhase}
              etaSec={gate?.etaSec ?? null}
              stillBoarding={buckets.boarding.length}
              bloomOn={seq.stage >= 3}
              animateBloom={seq.animate}
              fit={fitFlap}
            />
            {shownPhase === 'boarding' && gate?.waitingOn.length ? (
              <Text variant="data" tone="muted" style={{ marginTop: 10, textAlign: 'center' }}>
                waiting on {gate.waitingOn.join(', ')}
              </Text>
            ) : null}
          </View>
        </View>

        {/* ── the manifest ──────────────────────────────────────────────────── */}
        <Text variant="eyebrow" tone="muted" style={{ marginTop: 4 }}>
          MANIFEST
        </Text>
        <View style={styles.manifest}>
          {sections.map((sec) =>
            sec.people.length === 0 ? null : (
              <View key={sec.key} style={styles.group}>
                <Text variant="eyebrow" tone={sec.tone} accessibilityRole="header">
                  {`${sec.title} · ${sec.people.length}`}
                </Text>
                {sec.people.map((p) => (
                  <ManifestRow
                    key={p.id}
                    person={p}
                    isHost={isHost}
                    igniteDelayMs={seq.animate && seq.stage >= 1 ? (igniteDelays.get(p.id) ?? null) : null}
                    onApprove={() => s.approve(p.id)}
                    onDeny={() => s.deny(p.id)}
                  />
                ))}
              </View>
            ),
          )}
        </View>

        <View style={{ flex: 1, minHeight: 8 }} />

        {preflight ? (
          <Text variant="caption" tone="amber" style={styles.warn}>
            {preflight}
          </Text>
        ) : null}

        {isHost ? (
          <View style={styles.startWrap}>
            {/* Start lights as the last beat of the readiness sequence. */}
            <FilamentBloom lit={startLit} style={styles.startBloom} />
            <Button
              title={
                !readyToDepart
                  ? gate?.mode === 'precache'
                    ? 'Pre-caching…'
                    : 'Building head starts…'
                  : isResuming
                    ? 'Resume the show'
                    : 'Start the show'
              }
              subtitle={
                readyToDepart
                  ? isResuming
                    ? `Paused at ${fmtTime(resumePos)}`
                    : phase === 'all-aboard'
                      ? 'Lights down — everyone in sync'
                      : 'Head starts locked — downloads finish during the show'
                  : undefined
              }
              intent="amber"
              height={68}
              disabled={!readyToDepart}
              onPress={startShow}
            />
          </View>
        ) : downloadFailed ? (
          <Button title="The reel snagged — try again" intent="amber" height={68} onPress={s.retryDownload} />
        ) : !isHost && userLeftShow && playback && canJoinShow(progress, durationSec, targetPositionSec(playback, hostNowMs())) ? (
          <Button
            title="Rejoin the show"
            intent="amber"
            height={68}
            onPress={() => {
              s.enterShow()
              nav.navigate('Player')
            }}
          />
        ) : (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            style={[styles.status, { borderColor: t.palette.hairline }]}
          >
            <View style={styles.statusRow}>
              {phase === 'awaiting-approval' || progress < 1 ? <SyncDots /> : null}
              <Text variant="cardTitle" tone={phase === 'awaiting-approval' ? 'secondary' : 'cyan'} style={styles.statusText}>
                {guestStatus}
              </Text>
            </View>
          </View>
        )}

        <Button title="Leave the platform" intent="neutral" height={48} onPress={handleExitRequest} style={{ marginTop: 4 }} />
      </View>

      <CleanupSheet
        visible={showCleanupSheet}
        totalBytes={s.cacheStatus?.totalBytes ?? 0}
        movieBytes={s.cacheStatus?.movieBytes}
        subtitleBytes={s.cacheStatus?.subtitleBytes}
        onDeleteAndLeave={handleDeleteAndLeave}
        onKeepAndLeave={handleKeepAndLeave}
        onCancel={() => setShowCleanupSheet(false)}
        isDeleting={isDeleting}
        error={deleteError}
      />
    </Screen>
  )
}

type Sequence = {
  /** 0 idle · 1 rows igniting · 2 board flips · 3 bloom (+haptic) · 4 Start lit. */
  stage: 0 | 1 | 2 | 3 | 4
  /** False for an instant (re)appearance: a remount, or reduce-motion. */
  animate: boolean
}

/**
 * Drives the readiness climax as ONE event. The success haptic fires once per session milestone
 * (latched), and a remounted Lobby (back from the Player) jumps straight to the settled end state
 * instead of replaying the ritual.
 */
function useReadinessSequence(active: boolean, readyRows: number, key: string, reduced: boolean): Sequence {
  const [seq, setSeq] = useState<Sequence>({ stage: 0, animate: false })
  const rowsRef = useRef(readyRows)
  rowsRef.current = readyRows

  useEffect(() => {
    if (!active) {
      setSeq({ stage: 0, animate: false })
      return
    }
    if (milestones.has(key)) {
      setSeq({ stage: 4, animate: false })
      return
    }
    const sched = ignitionSchedule(rowsRef.current, reduced)
    setSeq({ stage: 1, animate: !reduced })
    const ids = [
      setTimeout(() => setSeq((x) => ({ ...x, stage: 2 })), sched.boardMs),
      setTimeout(() => {
        if (milestones.claim(key)) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
        setSeq((x) => ({ ...x, stage: 3 }))
      }, sched.bloomMs),
      setTimeout(() => setSeq((x) => ({ ...x, stage: 4 })), sched.startMs),
    ]
    return () => ids.forEach(clearTimeout)
  }, [active, key, reduced])

  return seq
}

/** The departure board's central readout for each phase. */
function BoardFace({
  phase,
  etaSec,
  stillBoarding,
  bloomOn,
  animateBloom,
  fit,
}: {
  phase: BoardPhase
  etaSec: number | null
  stillBoarding: number
  bloomOn: boolean
  animateBloom: boolean
  fit: (chars: number, max: number) => number
}) {
  const eyebrow = (text: string, tone: 'amber' | 'secondary' | 'muted') => (
    <Text variant="eyebrow" tone={tone} style={{ marginBottom: 10, textAlign: 'center' }}>
      {text}
    </Text>
  )
  // Per-row/board flaps stay silent: the readiness climax owns the one success haptic.
  switch (phase) {
    case 'awaiting-approval':
      return (
        <>
          {eyebrow('ASKING THE HOST', 'secondary')}
          <FlapText value="AT GATE" size={fit(7, 36)} tone="primary" stagger={45} haptics={false} />
          <Text variant="data" tone="muted" style={{ marginTop: 10, textAlign: 'center' }}>
            You board as soon as the host approves you
          </Text>
        </>
      )
    case 'solo':
      return (
        <>
          {eyebrow('WAITING FOR PASSENGERS', 'muted')}
          <FlapText value="STANDBY" size={fit(7, 36)} tone="primary" stagger={45} haptics={false} />
        </>
      )
    case 'boarding':
      return (
        <>
          {eyebrow('DEPARTS IN', 'secondary')}
          <FlapText value={departureClock(etaSec)} size={fit(5, 52)} tone="primary" stagger={0} haptics={false} />
        </>
      )
    case 'ready-to-depart':
      return (
        <>
          {eyebrow('READY TO DEPART', 'amber')}
          <FlapText value="CLEARED" size={fit(7, 36)} tone="amber" stagger={45} haptics={false} />
          {stillBoarding > 0 ? (
            <Text variant="data" tone="muted" style={{ marginTop: 10, textAlign: 'center' }}>
              {stillBoarding} still boarding — downloads finish during the show
            </Text>
          ) : null}
        </>
      )
    case 'all-aboard':
      return (
        <>
          {eyebrow('READY TO DEPART', 'amber')}
          <Bloom on={bloomOn} animate={animateBloom}>
            <FlapText value="ALL ABOARD" size={fit(10, 30)} tone="amber" stagger={55} haptics={false} />
          </Bloom>
        </>
      )
  }
}

/** One passenger: filament download, live speed, and an ABOARD flap — or the host's approve row. */
function ManifestRow({
  person,
  isHost,
  igniteDelayMs,
  onApprove,
  onDeny,
}: {
  person: Participant
  isHost: boolean
  /** When set, this ready row's filament flares after the delay (the readiness ignition). */
  igniteDelayMs: number | null
  onApprove: () => void
  onDeny: () => void
}) {
  const t = useTheme()
  const p = person
  const requested = p.status === 'requested'
  const left = p.status === 'left'
  const ready = p.status === 'ready'
  const pct = Math.round(p.progress * 100)
  const flare = useSharedValue(0)

  useEffect(() => {
    if (igniteDelayMs == null) return
    flare.value = withDelay(igniteDelayMs, withSequence(withTiming(1, { duration: 180 }), withTiming(0, { duration: 700 })))
    return () => cancelAnimation(flare)
  }, [igniteDelayMs, flare])
  const flareStyle = useAnimatedStyle(() => ({ opacity: flare.value }))

  return (
    <Animated.View
      entering={FadeIn.duration(240)}
      style={[styles.row, { borderColor: t.palette.hairline }]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.flare, { borderColor: t.palette.amber, shadowColor: t.palette.amber }, flareStyle]}
      />
      <View style={styles.rowHead}>
        <View style={[styles.dot, { backgroundColor: ready ? t.palette.amber : t.palette.textTertiary }]} />
        <Text variant="cardTitle" numberOfLines={1} style={styles.rowName}>
          {p.name}
        </Text>
        {ready ? (
          <FlapText value="ABOARD" size={13} tone="amber" stagger={30} haptics={false} />
        ) : left ? (
          <Text variant="data" tone="muted">
            left
          </Text>
        ) : requested ? (
          <Text variant="data" tone="amber">
            wants in
          </Text>
        ) : (
          <Text variant="data" tone="muted">
            {pct}%{p.downloadMbps > 0.1 ? `  ↓${p.downloadMbps.toFixed(1)} Mb/s` : ''}
          </Text>
        )}
      </View>

      {requested && isHost ? (
        <View style={styles.approveRow}>
          <Button title="Approve" icon={<Check size={16} color={t.palette.onAmber} strokeWidth={2.5} />} intent="amber" height={sizes.touch} onPress={onApprove} style={{ flex: 1 }} />
          <Button title="Deny" icon={<X size={16} color={t.palette.textSecondary} strokeWidth={2.5} />} intent="neutral" height={sizes.touch} onPress={onDeny} style={{ flex: 1 }} />
        </View>
      ) : !requested && !left ? (
        <View style={{ marginTop: 10 }}>
          <FilamentBar progress={ready ? 1 : p.progress} label={`${p.name} download`} />
          {isHost && p.id !== 'host' && (
            <View style={{ marginTop: 8, alignItems: 'flex-end' }}>
              <Button title="Remove" intent="danger" compact onPress={onDeny} />
            </View>
          )}
        </View>
      ) : left && isHost && p.id !== 'host' ? (
        <View style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <Button title="Dismiss" intent="neutral" compact onPress={onDeny} />
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

/** The climax bloom behind ALL ABOARD: a one-shot amber flare that settles to a warm afterglow. */
function Bloom({ on, animate, children }: { on: boolean; animate: boolean; children: ReactNode }) {
  const t = useTheme()
  const glow = useSharedValue(0)

  useEffect(() => {
    if (!on) {
      glow.value = 0
      return
    }
    glow.value = animate ? withSequence(withTiming(0.6, { duration: 240 }), withTiming(0.16, { duration: 1100 })) : 0.16
    return () => cancelAnimation(glow)
  }, [on, animate, glow])

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

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 14, paddingTop: 4 },
  board: { borderWidth: 1, borderRadius: radii.lg, padding: 18 },
  clock: { alignItems: 'center', marginTop: 22, marginBottom: 6 },
  ignite: { alignItems: 'center', justifyContent: 'center' },
  bloom: {
    position: 'absolute',
    width: 260,
    height: 90,
    borderRadius: 999,
    transform: [{ scaleX: 1.4 }],
  },
  manifest: { gap: 16 },
  group: { gap: 10 },
  row: { borderWidth: 1, borderRadius: radii.lg, padding: 14 },
  flare: {
    ...StyleSheet.absoluteFill,
    borderWidth: 1.5,
    borderRadius: radii.lg,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowName: { flex: 1 },
  approveRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  warn: { textAlign: 'center', marginBottom: 4 },
  startWrap: { justifyContent: 'center' },
  startBloom: { top: -30, bottom: -30, left: -20, right: -20 },
  status: { borderWidth: 1, borderRadius: radii.xl, minHeight: 68, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusText: { flexShrink: 1, textAlign: 'center' },
})
