import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useVideoPlayer, VideoView } from 'expo-video'
import { ChevronLeft, Pause, Play, RotateCcw, RotateCw } from 'lucide-react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useNavigation } from '@/navigation/context'
import { useSession } from '@/session/SessionProvider'
import { decideCorrection, roomGate, targetPositionSec } from '@/lib/sync/playback'

/**
 * The show. Immersive full-bleed video; the host drives play/pause/seek and broadcasts state,
 * every other phone is a follower that drift-corrects to the host's authoritative timeline
 * (see lib/sync/playback). Controls fade away; tap to bring them back. See docs/architecture.md §5.
 */

const SKIP_SEC = 10
const CORRECT_MS = 500 // client drift-check cadence
const HOST_BEAT_MS = 2000 // host re-stamps state so followers stay fresh
const CONTROLS_HIDE_MS = 3500

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

  const player = useVideoPlayer(s.movieUri ?? null, (p) => {
    p.loop = false
  })

  const [playing, setPlaying] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [pos, setPos] = useState(0)
  const [inSync, setInSync] = useState(true)
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoPausedRef = useRef(false) // host: the room-hold paused us (vs. a manual pause)
  const overrideRef = useRef(false) // host: chose to play through a hold; don't auto-pause again

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

  // Lightweight position readout for the overlay.
  useEffect(() => {
    const id = setInterval(() => setPos(player.currentTime), 250)
    return () => clearInterval(id)
  }, [player])

  // ── host: drive playback + keep followers fresh ─────────────────────────────
  const togglePlay = useCallback(() => {
    revealControls()
    if (playing) {
      player.pause()
      setPlaying(false)
      s.setHostPlayback(player.currentTime, false)
    } else {
      // Playing through an active hold is a deliberate override — don't let the gate re-pause us.
      if (s.waitingFor.length > 0) overrideRef.current = true
      player.play()
      setPlaying(true)
      s.setHostPlayback(player.currentTime, true)
    }
  }, [playing, player, s, revealControls])

  const skip = useCallback(
    (delta: number) => {
      revealControls()
      const to = Math.max(0, player.currentTime + delta)
      player.currentTime = to
      s.setHostPlayback(to, playing)
    },
    [player, playing, s, revealControls],
  )

  useEffect(() => {
    if (!isHost) return
    const id = setInterval(() => s.setHostPlayback(player.currentTime, playing), HOST_BEAT_MS)
    return () => clearInterval(id)
  }, [isHost, playing, player, s])

  // Host: reflect the playback it already published (e.g. "play from the top" from the lobby) when
  // the player mounts — otherwise it sits paused and the beat would broadcast isPlaying:false.
  useEffect(() => {
    if (!isHost) return
    const pb = s.playback
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
    if (isHost) s.setHostPlayback(player.currentTime, false)
  }
  useEffect(() => () => exitRef.current(), [])

  // Host: pause the room while any follower's player is stalled, and resume once everyone is ready
  // again. `autoPausedRef` keeps this from fighting a manual pause (we only auto-resume what we
  // auto-paused). The stall flag is "player not readyToPlay", so a pause can't clear it → no flap.
  const waiting = s.waitingFor
  useEffect(() => {
    if (!isHost) return
    const blocked = waiting.length > 0
    if (!blocked) overrideRef.current = false // straggler caught up — drop the override
    const action = roomGate({ autoPaused: autoPausedRef.current, playing }, blocked)
    if (action === 'pause' && !overrideRef.current) {
      autoPausedRef.current = true
      player.pause()
      setPlaying(false)
      s.setHostPlayback(player.currentTime, false)
      revealControls()
    } else if (action === 'resume') {
      autoPausedRef.current = false
      player.play()
      setPlaying(true)
      s.setHostPlayback(player.currentTime, true)
    }
  }, [isHost, waiting, playing, player, s, revealControls])

  // ── client: drift-correct to the host's state ───────────────────────────────
  const correct = useCallback(() => {
    const pb = s.playback
    if (!pb) return
    const target = targetPositionSec(pb, s.hostNowMs())
    const actual = player.currentTime
    const c = decideCorrection({ targetSec: target, actualSec: actual, isPlaying: pb.isPlaying, baseRate: pb.rate })
    if (c.seekToSec != null) player.currentTime = c.seekToSec
    if (c.action === 'pause') {
      player.pause()
    } else {
      player.playbackRate = c.rate
      player.play()
    }
    setInSync(Math.abs(target - actual) < 1)
  }, [player, s])

  // Apply immediately on each new host state, then keep nudging on a timer.
  useEffect(() => {
    if (isHost) return
    correct()
  }, [isHost, s.playback, correct])

  useEffect(() => {
    if (isHost) return
    const id = setInterval(correct, CORRECT_MS)
    return () => clearInterval(id)
  }, [isHost, correct])

  // Follower: tell the host whether our player is ready. "Not readyToPlay" = stalled (still loading
  // / buffering), so the host holds the room for us; clears the moment our player is ready.
  useEffect(() => {
    if (isHost) return
    const report = () => s.reportPlayback(player.status !== 'readyToPlay', player.currentTime)
    report()
    const id = setInterval(report, CORRECT_MS)
    return () => clearInterval(id)
  }, [isHost, player, s])

  return (
    <View style={styles.fill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={revealControls}>
        <VideoView style={StyleSheet.absoluteFill} player={player} contentFit="contain" nativeControls={false} />
      </Pressable>

      {showControls ? (
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
              <View style={[styles.dot, { backgroundColor: inSync ? t.palette.cyan : t.palette.amber }]} />
              <Text variant="eyebrow" tone="secondary">
                {isHost ? 'HOSTING' : inSync ? 'IN SYNC' : 'CATCHING UP'}
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
                {playing || s.playback?.isPlaying ? '' : 'paused by host'}
              </Text>
            </View>
          )}

          {/* bottom: a "holding for stragglers" notice (host), else the position readout */}
          <View style={styles.bottomBar} pointerEvents="none">
            <Text variant="data" tone="secondary">
              {isHost && waiting.length > 0
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
