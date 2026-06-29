import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useVideoPlayer, VideoView } from 'expo-video'
import { ChevronLeft, Pause, Play, RotateCcw, RotateCw } from 'lucide-react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useNavigation } from '@/navigation/context'
import { useSession } from '@/session/SessionProvider'
import { decideCorrection, roomGate, stallReport, targetPositionSec } from '@/lib/sync/playback'
import type { PlaybackState } from '@/lib/protocol'

/**
 * The show. Immersive full-bleed video; the host drives play/pause/seek and broadcasts state,
 * every other phone is a follower that drift-corrects to the host's authoritative timeline
 * (see lib/sync/playback). Controls fade away; tap to bring them back. See docs/architecture.md §5.
 */

const SKIP_SEC = 10
const CORRECT_MS = 500 // client drift-check cadence
const HOST_BEAT_MS = 2000 // host re-stamps state so followers stay fresh
const CONTROLS_HIDE_MS = 3500
const SEEK_SETTLE_MS = 2500 // after a corrective seek, leave the player alone to actually land + buffer
const IN_SYNC_SEC = 0.5 // |drift| under this shows the "in sync" badge

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function PlayerScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const insets = useSafeAreaInsets()
  const s = useSession()
  const isHost = s.role === 'host'
  // Stable handles: the session object's identity changes on every roster/heartbeat, so depending on
  // `s` directly would tear down and rebuild our effects/listeners constantly.
  const { setHostPlayback, reportPlayback, hostNowMs } = s
  const playback = s.playback
  const playbackRef = useRef(playback)
  playbackRef.current = playback // always read the latest host state without re-creating `correct`

  const player = useVideoPlayer(s.movieUri ?? null, (p) => {
    p.loop = false
  })

  const [playing, setPlaying] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [pos, setPos] = useState(0)
  const [inSync, setInSync] = useState(true)
  const [ended, setEnded] = useState(false)
  const lastSeekAtRef = useRef(0) // client: when we last issued a corrective seek (settle window)
  const appliedRateRef = useRef(1) // client: the playbackRate we last set (avoid redundant churn)
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const posRef = useRef(0) // last known playhead; read at unmount when the player may be released
  const autoPausedRef = useRef(false) // host: the room-hold paused us (vs. a manual pause)
  const overrideRef = useRef(false) // host: chose to play through a hold; don't auto-pause again
  const notReadySinceRef = useRef<number | null>(null) // client: when our player first went not-ready

  const revealControls = useCallback(() => {
    setShowControls(true)
    if (hideRef.current) clearTimeout(hideRef.current)
    hideRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_MS)
  }, [])

  useEffect(() => {
    revealControls()
    return () => {
      if (hideRef.current) clearTimeout(hideRef.current)
    }
  }, [revealControls])

  // Lightweight position readout for the overlay (also mirrored to a ref for the exit handler).
  useEffect(() => {
    const id = setInterval(() => {
      posRef.current = player.currentTime
      setPos(player.currentTime)
    }, 250)
    return () => clearInterval(id)
  }, [player])

  // End of the movie: the host ends the show for everyone (broadcasts a paused state at the end) and
  // both roles show "The End". Reaching the end is NOT a stall, so it must never hold the room.
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      setEnded(true)
      revealControls() // make sure the "The End" overlay is actually on screen
      if (isHost) {
        setPlaying(false)
        // Broadcast an explicit ended state at the exact end so followers show "The End" too, even
        // if they paused just shy of EOF and never fired their own playToEnd.
        setHostPlayback(player.duration || posRef.current, false, 1, true)
      }
    })
    return () => sub.remove()
  }, [player, isHost, setHostPlayback, revealControls])

  // ── host: drive playback + keep followers fresh ─────────────────────────────
  const togglePlay = useCallback(() => {
    revealControls()
    if (playing) {
      player.pause()
      setPlaying(false)
      setHostPlayback(player.currentTime, false)
    } else {
      // Pressing Play while the gate is actively holding the room is a deliberate override (play on
      // without that straggler). Only then — NOT for the normal start where guests are still loading,
      // which should still wait for them.
      if (autoPausedRef.current) overrideRef.current = true
      setEnded(false)
      player.play()
      setPlaying(true)
      setHostPlayback(player.currentTime, true)
    }
  }, [playing, player, setHostPlayback, revealControls])

  const skip = useCallback(
    (delta: number) => {
      revealControls()
      setEnded(false)
      const to = Math.max(0, player.currentTime + delta)
      player.currentTime = to
      setHostPlayback(to, playing)
    },
    [player, playing, setHostPlayback, revealControls],
  )

  useEffect(() => {
    if (!isHost) return
    // Carry `ended` so the 2s re-stamp doesn't clear "The End" on followers after EOF.
    const id = setInterval(() => setHostPlayback(player.currentTime, playing, 1, ended), HOST_BEAT_MS)
    return () => clearInterval(id)
  }, [isHost, playing, ended, player, setHostPlayback])

  // Host: reflect the playback it already published (e.g. "play from the top" from the lobby) when
  // the player mounts — otherwise it sits paused and the beat would broadcast isPlaying:false.
  useEffect(() => {
    if (!isHost) return
    const pb = playbackRef.current
    if (!pb) return
    if (pb.positionSec > 0) player.currentTime = pb.positionSec
    if (pb.isPlaying) {
      player.play()
      setPlaying(true)
    }
    // mount-only: the host owns playback from here via the controls.
  }, [])

  // Host: if it leaves the show (back), pause everyone rather than letting followers run on alone.
  const exitRef = useRef<() => void>(() => {})
  exitRef.current = () => {
    // Use the mirrored position, never the player — by unmount expo-video may have released it
    // (touching a released player throws "shared object already released").
    if (isHost) setHostPlayback(posRef.current, false)
  }
  useEffect(() => () => exitRef.current(), [])

  // Host: pause the room while any follower's player is stalled, and resume once everyone is ready
  // again. `autoPausedRef` keeps this from fighting a manual pause (we only auto-resume what we
  // auto-paused). The stall flag is "player not readyToPlay", so a pause can't clear it → no flap.
  const waiting = s.waitingFor
  useEffect(() => {
    if (!isHost || ended) return // the show's over — don't hold/resume on an end-of-stream blip
    const blocked = waiting.length > 0
    if (!blocked) overrideRef.current = false // straggler caught up — drop the override
    const action = roomGate({ autoPaused: autoPausedRef.current, playing }, blocked)
    if (action === 'pause' && !overrideRef.current) {
      autoPausedRef.current = true
      player.pause()
      setPlaying(false)
      setHostPlayback(player.currentTime, false)
      revealControls()
    } else if (action === 'resume') {
      autoPausedRef.current = false
      player.play()
      setPlaying(true)
      setHostPlayback(player.currentTime, true)
    }
  }, [isHost, ended, waiting, playing, player, setHostPlayback, revealControls])

  // ── client: drift-correct to the host's state ───────────────────────────────
  // The guiding rule is SMOOTHNESS: play at the host's rate and touch the player only when something
  // must change. Re-seeking / re-setting the rate / re-calling play() every tick (the old behaviour)
  // makes the video stutter frame-by-frame and drop audio. So: seek only for a real desync and never
  // again until it has settled; nudge the rate only when it meaningfully changes; never call play()
  // if we're already playing.
  const correct = useCallback(() => {
    const pb = playbackRef.current
    if (!pb) return
    const target = targetPositionSec(pb, hostNowMs())
    const actual = player.currentTime
    const now = Date.now()
    const settling = now - lastSeekAtRef.current < SEEK_SETTLE_MS
    const c = decideCorrection({ targetSec: target, actualSec: actual, isPlaying: pb.isPlaying, baseRate: pb.rate })

    // A hard seek (big desync) — but not while a previous seek is still landing, or we thrash.
    if (c.seekToSec != null && !settling) {
      player.currentTime = c.seekToSec
      lastSeekAtRef.current = now
    }

    if (c.action === 'pause') {
      if (player.playing) player.pause()
    } else {
      // Hold the host's plain rate while a seek settles; otherwise apply the (gentle) nudged rate.
      const rate = settling ? pb.rate : c.rate
      if (Math.abs(rate - appliedRateRef.current) > 0.02) {
        player.playbackRate = rate
        appliedRateRef.current = rate
      }
      if (!player.playing) player.play()
    }
    setInSync(Math.abs(target - actual) < IN_SYNC_SEC)
  }, [player, hostNowMs])

  // React to each NEW host state: mirror "The End", and let a host DISCONTINUITY (play/pause toggle,
  // rate change, or a seek/skip that jumps the timeline) bypass the seek-settle cooldown so we follow
  // it at once — the cooldown is only meant to stop us re-seeking the SAME timeline mid-seek.
  const lastStateRef = useRef<PlaybackState | null>(null)
  useEffect(() => {
    if (isHost) return
    const pb = playback
    if (pb) {
      setEnded(pb.ended === true) // any non-ended state (incl. a paused host seek away from EOF) clears it
      const prev = lastStateRef.current
      const predicted = prev ? targetPositionSec(prev, pb.hostMonotonicMs) : pb.positionSec
      const discontinuous =
        !prev || prev.isPlaying !== pb.isPlaying || prev.rate !== pb.rate || Math.abs(predicted - pb.positionSec) > 1.0
      if (discontinuous) lastSeekAtRef.current = 0 // allow an immediate corrective seek to the new point
      lastStateRef.current = pb
    }
    correct()
  }, [isHost, playback, correct])

  useEffect(() => {
    if (isHost) return
    const id = setInterval(correct, CORRECT_MS)
    return () => clearInterval(id)
  }, [isHost, correct])

  // Follower: tell the host whether our player can keep up. We DEBOUNCE the raw readiness signal —
  // it blips to "not ready" on every drift-seek, which would otherwise make the host hold the room
  // and never resume (a freeze). Only a sustained not-ready counts as a stall; it clears at once
  // when the player is ready again (see stallReport).
  useEffect(() => {
    if (isHost) return
    const report = () => {
      const r = stallReport(player.status !== 'readyToPlay', notReadySinceRef.current, Date.now())
      notReadySinceRef.current = r.notReadySince
      reportPlayback(r.stalled, player.currentTime)
    }
    report()
    const id = setInterval(report, CORRECT_MS)
    return () => clearInterval(id)
  }, [isHost, player, reportPlayback])

  return (
    <View style={styles.fill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={revealControls}>
        <VideoView style={StyleSheet.absoluteFill} player={player} contentFit="contain" nativeControls={false} />
      </Pressable>

      {showControls || ended ? (
        <View style={[styles.overlay, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]} pointerEvents="box-none">
          {/* top bar */}
          <View style={styles.topBar} pointerEvents="box-none">
            <Pressable
              onPress={nav.goBack}
              hitSlop={12}
              style={[styles.iconBtn, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}
            >
              <ChevronLeft size={20} color={t.palette.textSecondary} strokeWidth={2.25} />
            </Pressable>
            <View style={styles.syncTag}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: s.reconnecting ? t.palette.danger : inSync ? t.palette.cyan : t.palette.amber },
                ]}
              />
              <Text variant="eyebrow" tone="secondary">
                {ended
                  ? 'THE END'
                  : s.reconnecting
                    ? 'RECONNECTING…'
                    : isHost
                      ? 'HOSTING'
                      : inSync
                        ? 'IN SYNC'
                        : 'CATCHING UP'}
              </Text>
            </View>
          </View>

          {/* middle: host transport (always available, even while holding, so the host is never
              stuck), or the follower's status */}
          {isHost ? (
            <View style={styles.transport} pointerEvents="box-none">
              <Pressable onPress={() => skip(-SKIP_SEC)} hitSlop={12} style={styles.transportBtn}>
                <RotateCcw size={26} color={t.palette.textPrimary} strokeWidth={2} />
              </Pressable>
              <Pressable
                onPress={togglePlay}
                hitSlop={12}
                style={[styles.playBtn, { backgroundColor: t.palette.amber }]}
              >
                {playing ? <Pause size={30} color="#0A0E16" strokeWidth={2.5} /> : <Play size={30} color="#0A0E16" strokeWidth={2.5} />}
              </Pressable>
              <Pressable onPress={() => skip(SKIP_SEC)} hitSlop={12} style={styles.transportBtn}>
                <RotateCw size={26} color={t.palette.textPrimary} strokeWidth={2} />
              </Pressable>
            </View>
          ) : (
            <View style={styles.transport} pointerEvents="none">
              <Text variant="data" tone="tertiary">
                {ended || playing || s.playback?.isPlaying ? '' : 'paused by host'}
              </Text>
            </View>
          )}

          {/* bottom: a "holding for stragglers" notice (host), else the position readout */}
          <View style={styles.bottomBar} pointerEvents="none">
            <Text variant="data" tone="secondary">
              {ended
                ? 'The End'
                : isHost && waiting.length > 0
                  ? `Holding for ${waiting.join(', ')} to catch up…`
                  : `${fmt(pos)}${player.duration ? ` / ${fmt(player.duration)}` : ''}`}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', paddingHorizontal: 20 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  syncTag: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
  transportBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  playBtn: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  bottomBar: { alignItems: 'center' },
})
