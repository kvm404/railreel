import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, AppState, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Easing, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated'
import { useVideoPlayer, VideoView, type VideoPlayerStatus } from 'expo-video'
import { ChevronLeft, Pause, Play, RotateCcw, RotateCw, Subtitles, Trash2 } from 'lucide-react-native'
import { Button, FlapText, Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { useTheme } from '@/theme/ThemeProvider'
import { motion, palette } from '@/theme/tokens'
import { useBackHandler, useNavigation } from '@/navigation/context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useLatestCallback } from '@/hooks/useLatestCallback'
import { usePlayhead } from '@/hooks/usePlayhead'
import { resumeExit } from '@/lib/nav/exitGuard'
import { useSession } from '@/session/SessionProvider'
import { CaptionOverlay } from '@/components/CaptionOverlay'
import { ChatSheet } from '@/components/ChatSheet'
import { ChatTicker } from '@/components/ChatTicker'
import { CleanupSheet } from '@/components/CleanupSheet'
import { FloatingReactions } from '@/components/FloatingReactions'
import { ModerationBanner } from '@/components/ModerationBanner'
import { Curtain, SyncTag, type SyncTone } from '@/components/PlayerChrome'
import { PlayerStatusOverlay } from '@/components/PlayerStatusOverlay'
import { ReactionRail } from '@/components/ReactionRail'
import { RequestFeedbackToast } from '@/components/RequestFeedbackToast'
import { Scrubber } from '@/components/Scrubber'
import {
  decideCorrection,
  nativePauseVerdict,
  nextSeekLead,
  roomGate,
  stallReport,
  targetPositionSec,
} from '@/lib/sync/playback'
import { playerLayout, TOP_FADE } from '@/lib/player/layout'
import { shouldPublishHostExit } from '@/lib/player/exit'
import { lastChatId, unreadCount } from '@/lib/social/feed'
import { cleanupFailureMessage, formatBytes, type ClearCacheResult } from '@/lib/storage'
import type { PlaybackState } from '@/lib/protocol'
import type { SubtitleCue } from '@/lib/subtitles'

/**
 * The show. Immersive full-bleed video; the host drives play/pause/seek and broadcasts state,
 * every other phone is a follower that drift-corrects to the host's authoritative timeline
 * (see lib/sync/playback). Controls ride in letterbox curtains that slide away; tap the film to
 * bring them back. See docs/architecture.md §5 and docs/design-language.md (Player).
 *
 * Rendering: the playhead lives outside React state (hooks/usePlayhead) — captions, the time
 * readout and the filament subscribe to it themselves — and drift correction runs on timers, so
 * this screen only re-renders on session/transport changes, not ten times a second.
 */

const SKIP_SEC = 10
const CORRECT_MS = 500 // client drift-check cadence
const HOST_BEAT_MS = 2000 // host re-stamps state so followers stay fresh
const SEEK_SETTLE_MS = 2500 // after a corrective seek, leave the player alone to actually land + buffer
const IN_SYNC_SEC = 0.35 // |drift| under this shows the "in sync" badge
const CONTROLS_HIDE_MS = 3500 // while playing, chrome (controls + reaction rail) melts away after this
/** Host: how long a native not-playing must persist before we call it a pause (rebuffers blip). */
const NATIVE_PAUSE_CONFIRM_MS = 500
/** A loading status shorter than this (a drift-seek landing) never shows the buffering cue. */
const BUFFERING_SHOW_MS = 450
/**
 * Local mirror of the store's REACTION_SEND_GAP_MS (250ms) plus a little margin, so a tap we
 * accept is one the store accepts too (its timestamp is taken a hair after ours) — the haptic
 * then only ever confirms a reaction that was really sent.
 */
const LOCAL_REACTION_GAP_MS = 260
const NO_CUES: SubtitleCue[] = []

/** Read cursor for the chat badge, kept across Player remounts (ids are monotonic app-wide). */
let lastSeenChatId = 0

export function PlayerScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const insets = useSafeAreaInsets()
  const { width, height, fontScale } = useWindowDimensions()
  const s = useSession()
  const isHost = s.role === 'host'
  // Stable handles: the session object's identity changes on every roster/heartbeat, so depending on
  // `s` directly would tear down and rebuild our effects/listeners constantly.
  const {
    setHostPlayback,
    reportPlayback,
    hostNowMs,
    getCacheInfo,
    handlePlaybackRequest,
    sendReaction,
    sendChat,
    sendPlaybackRequest,
    clearPlaybackRequestStatus,
    registerHostTransport,
  } = s
  const playback = s.playback
  const playbackRef = useRef(playback)
  playbackRef.current = playback // always read the latest host state without re-creating `correct`

  // Session torn down under us (host ended the show / left, reconnect gave up, or client denied): don't sit on
  // a dead player showing "paused by host" — reset to Home (which shows the store's end card) or to
  // the Lobby's denied screen. A reset, not a push, so Back can't return to this dead player.
  useEffect(() => {
    if (s.role === 'none' || s.clientPhase === 'denied') nav.reset(s.clientPhase === 'denied' ? 'Lobby' : 'Home')
  }, [s.role, s.clientPhase, nav])

  const player = useVideoPlayer(s.movieUri ?? null, (p) => {
    p.loop = false
  })
  const playhead = usePlayhead(player)

  const [playing, setPlaying] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [seenChatId, setSeenChatId] = useState(lastSeenChatId)
  const [inSync, setInSync] = useState(true)
  const [ended, setEnded] = useState(false)
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true)
  const [showCleanupSheet, setShowCleanupSheet] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [nativeStatus, setNativeStatus] = useState<VideoPlayerStatus>(() => player.status)
  const [playerError, setPlayerError] = useState<string | null>(null)
  const [everReady, setEverReady] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [durationSec, setDurationSec] = useState(0)
  const [bottomCurtainH, setBottomCurtainH] = useState(0)
  const [topCurtainH, setTopCurtainH] = useState(0)
  const [captionH, setCaptionH] = useState(0)
  const [screenReader, setScreenReader] = useState(false)

  const playingRef = useRef(playing)
  playingRef.current = playing
  const endedRef = useRef(ended)
  endedRef.current = ended

  // Query cache status once when playback concludes. Depend on the stable callback, not `s`: the
  // query itself sets a fresh cacheStatus (a new `s`), which would otherwise re-run this forever.
  useEffect(() => {
    if (ended) getCacheInfo().catch(() => {})
  }, [ended, getCacheInfo])

  // Back (header or hardware): after The End, offer the cache cleanup; otherwise step out to the
  // Lobby (the session stays). A follower marks itself out of the show in the SAME update as the
  // pop, so the Lobby mounts already knowing — its auto-enter can't bounce us straight back in.
  // Async continuations act only if this player (and its session) is still the one on screen — see
  // lib/nav/exitGuard: a purge that settles after the host ended the show must not leave() a newer one.
  const mounted = useMountedRef()
  const sessionRef = useRef(s)
  sessionRef.current = s
  // The session this player was mounted for, and whether WE just left it: leave() and the
  // navigation reset land in one commit, so the last-rendered `s` still says "host" at unmount.
  const mountedJoinCodeRef = useRef(s.joinCode)
  const leftSessionRef = useRef(false)

  const handleBackPress = useLatestCallback(async () => {
    if (ended) {
      const info = await s.getCacheInfo()
      if (!mounted.current) return
      if (info.totalBytes > 0) {
        setDeleteError(null)
        setShowCleanupSheet(true)
        return
      }
    }
    if (!isHost) s.exitShow()
    if (nav.canGoBack) nav.goBack()
    else nav.reset('Lobby')
  })
  useBackHandler(() => {
    void handleBackPress()
    return true
  })

  // Leave only once the files are PROVABLY gone (see lib/storage cleanupFailureMessage): a failed
  // purge keeps the sheet open, locked, with the reason, a retry and "Leave anyway".
  const handleDeleteAndLeave = async () => {
    setIsDeleting(true)
    // (deleteError stays up during a retry so the sheet doesn't flicker back to its unlocked form)
    let result: ClearCacheResult | null = null
    try {
      result = await s.purgeCache()
    } catch {
      result = null
    }
    if (!mounted.current) return
    setIsDeleting(false)
    const failure = cleanupFailureMessage(result)
    if (failure) {
      setDeleteError(failure)
      return
    }
    setShowCleanupSheet(false)
    const step = resumeExit({ mounted: mounted.current, sessionActive: sessionRef.current.role !== 'none' })
    if (step === 'leave') {
      leftSessionRef.current = true
      s.leave()
    }
    if (step !== 'skip') nav.reset('Home')
  }

  const handleKeepAndLeave = () => {
    setShowCleanupSheet(false)
    leftSessionRef.current = true
    s.leave()
    nav.reset('Home')
  }

  const lastSeekAtRef = useRef(0) // client: when we last issued a corrective seek (settle window)
  const pendingSeekAtRef = useRef<number | null>(null) // client: seek issued, landing not yet measured
  const seekLeadRef = useRef(0) // client: EMA of this device's seek-landing latency (s)
  const appliedRateRef = useRef(1) // client: the playbackRate we last set (avoid redundant churn)
  const lastDriftLogRef = useRef(0) // client: dev drift telemetry throttle
  const autoPausedRef = useRef(false) // host: the room-hold paused us (vs. a manual pause)
  const overrideRef = useRef(false) // host: chose to play through a hold; don't auto-pause again
  const notReadySinceRef = useRef<number | null>(null) // client: when our player first went not-ready
  // client: we asked the native player to play. Mid-buffer `player.playing` is false while ExoPlayer
  // still has playback requested, so `playing` alone can't tell us a pause is needed.
  const playRequestedRef = useRef(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // follower: correct only while on screen ('unknown' at launch counts as on screen)
  const appActiveRef = useRef(AppState.currentState !== 'background')
  const [appActive, setAppActive] = useState(appActiveRef.current) // host: the room gate never resumes while away

  // TalkBack users navigate the chrome element by element — never pull it out from under them.
  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader).catch(() => {})
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader)
    return () => sub.remove()
  }, [])

  // "Is the show playing?" — the host owns its local transport; a follower's own `playing` state
  // is never set (its player is driven by drift-correction), so it reads the host's authoritative
  // isPlaying. Without this a follower's chrome would never auto-hide.
  const showIsPlaying = isHost ? playing : (playback?.isPlaying ?? false)
  const canAutoHide = showIsPlaying && !screenReader && !chatOpen

  // Reveal controls (+ the reaction rail), and while the movie is PLAYING arm an auto-hide so the
  // chrome melts away and the film is unobstructed. While paused (e.g. waiting for the host to
  // press play) they stay put — a vanishing play button reads as broken.
  const revealControls = useLatestCallback(() => {
    setShowControls(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    if (canAutoHide) hideTimerRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_MS)
  })

  // Re-arm (or cancel) the auto-hide whenever play/pause flips: hide the chrome once playing,
  // bring it back and keep it when paused.
  useEffect(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    if (canAutoHide && showControls) hideTimerRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_MS)
    else if (!canAutoHide) setShowControls(true)
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [canAutoHide, showControls])

  // ── native player status ─────────────────────────────────────────────────────
  // Loading / error / duration come from expo-video's own events, so the chrome can tell the
  // truth (no "IN SYNC" over a black frame) and the host can notice pauses it didn't make.
  const nativeCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkNativePause = useLatestCallback(() => {
    nativeCheckRef.current = null
    if (!isHost) return
    let status: VideoPlayerStatus
    let nativePlaying: boolean
    let cur: number
    let dur: number
    try {
      status = player.status
      nativePlaying = player.playing
      cur = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0
      dur = player.duration
    } catch {
      return // released under us (unmount)
    }
    const atEnd = endedRef.current || (dur > 0 && cur >= dur - 0.5)
    const verdict = nativePauseVerdict({ intendsPlaying: playingRef.current, nativePlaying, status, atEnd })
    if (verdict === 'wait') {
      scheduleNativeCheck()
    } else if (verdict === 'reconcile') {
      // Audio focus loss, a call, unplugged headphones, an error: the film stopped here, so the
      // room stops too — followers must not run ahead of a frozen host. Resuming is a manual Play.
      autoPausedRef.current = false
      overrideRef.current = false
      try {
        player.pause()
      } catch {
        // already released
      }
      setPlaying(false)
      setHostPlayback(cur, false)
      revealControls()
    }
  })
  const scheduleNativeCheck = useLatestCallback(() => {
    if (nativeCheckRef.current) clearTimeout(nativeCheckRef.current)
    nativeCheckRef.current = setTimeout(checkNativePause, NATIVE_PAUSE_CONFIRM_MS)
  })
  useEffect(
    () => () => {
      if (nativeCheckRef.current) clearTimeout(nativeCheckRef.current)
    },
    [],
  )

  useEffect(() => {
    const status = player.addListener('statusChange', ({ status: next, error }) => {
      setNativeStatus(next)
      if (next === 'readyToPlay') {
        setEverReady(true)
        setPlayerError(null)
        if (player.duration > 0) setDurationSec(player.duration)
      } else if (next === 'error') {
        setPlayerError(error?.message ?? null)
      }
      if (next === 'error') scheduleNativeCheck()
    })
    const playingSub = player.addListener('playingChange', ({ isPlaying }) => {
      if (!isPlaying) scheduleNativeCheck()
    })
    const load = player.addListener('sourceLoad', ({ duration }) => {
      if (duration > 0) setDurationSec(duration)
    })
    return () => {
      status.remove()
      playingSub.remove()
      load.remove()
    }
  }, [player, scheduleNativeCheck])

  // A rebuffer has to last a beat before we say so (drift-seeks blip `loading` constantly).
  useEffect(() => {
    if (nativeStatus !== 'loading' && !(nativeStatus === 'idle' && s.movieUri)) {
      setBuffering(false)
      return
    }
    const id = setTimeout(() => setBuffering(true), BUFFERING_SHOW_MS)
    return () => clearTimeout(id)
  }, [nativeStatus, s.movieUri])

  const retryPlayback = useLatestCallback(() => {
    if (!s.movieUri) return
    const at = playhead.get()
    setPlayerError(null)
    player
      .replaceAsync(s.movieUri)
      .then(() => {
        if (isHost && at > 0) player.currentTime = at // followers re-seek via drift correction
      })
      .catch(() => {})
  })
  const leaveToLobby = useLatestCallback(() => {
    void handleBackPress()
  })

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
        setHostPlayback(player.duration || playhead.get(), false, 1, true)
      }
    })
    return () => sub.remove()
  }, [player, isHost, setHostPlayback, revealControls, playhead])

  // ── host: drive playback + keep followers fresh ─────────────────────────────
  const togglePlay = useLatestCallback(() => {
    revealControls()
    if (playing) {
      autoPausedRef.current = false
      overrideRef.current = false
      player.pause()
      setPlaying(false)
      setHostPlayback(player.currentTime, false)
    } else {
      // Pressing Play while the gate is actively holding the room is a deliberate override (play on
      // without that straggler). Only then — NOT for the normal start where guests are still loading,
      // which should still wait for them.
      autoPausedRef.current = false
      overrideRef.current = true
      setEnded(false)
      player.play()
      setPlaying(true)
      setHostPlayback(player.currentTime, true)
    }
  })

  // Host seek (skip buttons, filament scrub, TalkBack adjust): move, show it at once, broadcast.
  const seekHost = useLatestCallback((toSec: number) => {
    revealControls()
    setEnded(false)
    const max = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY
    const to = Math.min(max, Math.max(0, toSec))
    player.currentTime = to
    playhead.seekTo(to)
    setHostPlayback(to, playing)
  })
  const skip = useLatestCallback((delta: number) => {
    const cur = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0
    seekHost(cur + delta)
  })
  const skipBack = useCallback(() => skip(-SKIP_SEC), [skip])
  const skipForward = useCallback(() => skip(SKIP_SEC), [skip])

  // Host: "one bad device can't hold the group hostage" (PRD §7) — play through an active hold.
  // The straggler keeps downloading/buffering and its player drift-corrects back into the show
  // the moment it can; the override clears itself once everyone has recovered.
  const playWithout = useCallback(() => {
    overrideRef.current = true
    autoPausedRef.current = false
    setEnded(false)
    player.play()
    setPlaying(true)
    setHostPlayback(player.currentTime, true)
  }, [player, setHostPlayback])

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
    if (pb.positionSec > 0) {
      player.currentTime = pb.positionSec
      playhead.seekTo(pb.positionSec)
    }
    if (pb.isPlaying) {
      player.play()
      setPlaying(true)
    }
    // mount-only: the host owns playback from here via the controls.
  }, [])

  // App lifecycle. The host is the session's lifeline (PRD §8, architecture §9): if it leaves the
  // foreground mid-show, pause the room at once and say so — followers must not play on against a
  // host that stopped (expo-video pauses itself in the background). The session itself stays up
  // (foreground service); resuming is a deliberate Play. A backgrounded follower stops correcting
  // (or it would restart audio behind the lock screen) and re-syncs the moment it's back.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active'
      appActiveRef.current = active
      setAppActive(active)
      if (isHost) {
        if (!active) {
          // Drop any room hold / override on EVERY trip away — even when already held (not
          // playing) — or a straggler recovering while we're away would let the gate auto-resume.
          autoPausedRef.current = false
          overrideRef.current = false
        }
        if (!active && playingRef.current) {
          let cur = playhead.get()
          try {
            cur = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : cur
            player.pause()
          } catch {
            // released
          }
          setPlaying(false)
          setHostPlayback(cur, false)
        }
        return
      }
      if (!active) {
        try {
          // Unconditionally: mid-buffer expo-video reports playing=false while ExoPlayer still has
          // playback requested, which would start audio behind the lock screen once it lands.
          player.pause()
          playRequestedRef.current = false
        } catch {
          // released
        }
      } else {
        lastSeekAtRef.current = 0 // we've been away — allow an immediate corrective seek
        correctRef.current()
      }
    })
    return () => sub.remove()
  }, [isHost, player, playhead, setHostPlayback])

  // Register host transport with session store so approved moderation requests can actuate playback
  useEffect(() => {
    if (!isHost) return
    registerHostTransport({
      pause: () => {
        autoPausedRef.current = false
        overrideRef.current = false
        player.pause()
        setPlaying(false)
      },
      seekTo: (positionSec: number) => {
        setEnded(false)
        player.currentTime = positionSec
        playhead.seekTo(positionSec)
      },
      getCurrentPosition: () => {
        return Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0
      },
      isPlaying: () => playing,
    })
    return () => {
      registerHostTransport(null)
    }
  }, [isHost, player, playing, registerHostTransport, playhead])

  // If host leaves the show (back), pause everyone rather than letting followers run on alone.
  // If follower leaves the show (back), notify session so inShow resets and lobby does not trap.
  const exitRef = useRef<() => void>(() => {})
  exitRef.current = () => {
    // Use the mirrored position, never the player — by unmount expo-video may have released it
    // (touching a released player throws "shared object already released"). Keep `ended`, or
    // guests lose "The End" the moment the host steps back to the lobby; and only for the session
    // we were hosting — never stamp a state onto one that has ended or been replaced.
    if (isHost) {
      const live = sessionRef.current
      const publish = shouldPublishHostExit({
        leftSession: leftSessionRef.current,
        role: live.role,
        joinCode: live.joinCode,
        mountedJoinCode: mountedJoinCodeRef.current,
      })
      if (publish) {
        setHostPlayback(playhead.get(), false, 1, endedRef.current)
      }
    } else {
      s.exitShow()
    }
  }
  useEffect(() => () => exitRef.current(), [])

  // Host: pause the room while any follower's player is stalled, and resume once everyone is ready
  // again. `autoPausedRef` keeps this from fighting a manual pause (we only auto-resume what we
  // auto-paused). The stall flag is "player not readyToPlay", so a pause can't clear it → no flap.
  const waiting = s.waitingFor
  useEffect(() => {
    if (!isHost || ended) return // the show's over — don't hold/resume on an end-of-stream blip
    if (!appActive) return // host is away: the room stays paused until a deliberate Play
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
  }, [isHost, ended, appActive, waiting, playing, player, setHostPlayback, revealControls])

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
    const actual = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0
    const now = Date.now()
    const settling = now - lastSeekAtRef.current < SEEK_SETTLE_MS

    // A seek we issued has landed (player ready again while the settle window runs): measure how
    // long the landing took and fold it into this device's seek-lead estimate, so the NEXT seek
    // aims far enough ahead to land on the moving target.
    if (settling && pendingSeekAtRef.current != null && player.status === 'readyToPlay') {
      seekLeadRef.current = nextSeekLead(seekLeadRef.current, (now - pendingSeekAtRef.current) / 1000)
      pendingSeekAtRef.current = null
    }

    const c = decideCorrection({
      targetSec: target,
      actualSec: actual,
      isPlaying: pb.isPlaying,
      baseRate: pb.rate,
      seekLeadSec: seekLeadRef.current,
    })

    // A hard seek (big desync) — but not while a previous seek is still landing, or we thrash.
    if (c.seekToSec != null && !settling) {
      player.currentTime = Math.max(0, c.seekToSec)
      lastSeekAtRef.current = now
      pendingSeekAtRef.current = now
    }

    if (c.action === 'pause') {
      // Also while buffering: a play request left standing would start the film once it lands,
      // against a host that has paused.
      if (player.playing || playRequestedRef.current) player.pause()
      playRequestedRef.current = false
    } else {
      // Hold the host's plain rate while a seek settles; otherwise apply the nudged rate.
      const rate = settling ? pb.rate : c.rate
      if (Math.abs(rate - appliedRateRef.current) > 0.01) {
        player.playbackRate = rate
        appliedRateRef.current = rate
      }
      if (!player.playing) player.play()
      playRequestedRef.current = true
    }
    setInSync(Math.abs(target - actual) < IN_SYNC_SEC)

    // Dev-only sync telemetry (Metro console): the number the PRD's sub-100ms target is judged by.
    if (__DEV__ && now - lastDriftLogRef.current > 5000) {
      lastDriftLogRef.current = now
      console.log(`[sync] drift=${(target - actual).toFixed(3)}s lead=${seekLeadRef.current.toFixed(2)}s rate=${appliedRateRef.current.toFixed(3)}`)
    }
  }, [player, hostNowMs])
  const correctRef = useRef(correct)
  correctRef.current = correct

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
    if (appActiveRef.current) correct()
  }, [isHost, playback, correct])

  useEffect(() => {
    if (isHost) return
    const id = setInterval(() => {
      if (appActiveRef.current) correct()
    }, CORRECT_MS)
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
      const cur = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0
      reportPlayback(r.stalled, cur)
    }
    report()
    const id = setInterval(report, CORRECT_MS)
    return () => clearInterval(id)
  }, [isHost, player, reportPlayback])

  // ── the cabin: chat + reactions ─────────────────────────────────────────────
  // Unread = lines past a monotonic read cursor; while the sheet is open we're caught up.
  const chatLog = s.chatLog
  useEffect(() => {
    if (!chatOpen) return
    const id = lastChatId(chatLog, lastSeenChatId)
    lastSeenChatId = id
    setSeenChatId(id)
  }, [chatOpen, chatLog])
  const unread = unreadCount(chatLog, seenChatId)

  const chatButtonRef = useRef<View>(null)
  const openChat = useLatestCallback(() => {
    revealControls()
    setChatOpen(true)
  })
  const closeChat = useLatestCallback(() => {
    setChatOpen(false)
    // Hand screen-reader focus back to where the sheet was opened from.
    if (screenReader) {
      setTimeout(() => {
        if (chatButtonRef.current) AccessibilityInfo.sendAccessibilityEvent(chatButtonRef.current, 'focus')
      }, 350)
    }
  })

  const lastReactAtRef = useRef(0)
  const onReact = useLatestCallback((emoji: string): boolean => {
    revealControls() // reacting is interaction — keep the chrome up a bit longer
    const now = Date.now()
    if (now - lastReactAtRef.current < LOCAL_REACTION_GAP_MS) return false
    lastReactAtRef.current = now
    sendReaction(emoji)
    return true
  })

  const approveRequest = useCallback((id: string) => handlePlaybackRequest(id, true), [handlePlaybackRequest])
  const dismissRequest = useCallback((id: string) => handlePlaybackRequest(id, false), [handlePlaybackRequest])
  const askPause = useLatestCallback(() => {
    revealControls()
    sendPlaybackRequest('pause')
  })
  const askRewind = useLatestCallback(() => {
    revealControls()
    sendPlaybackRequest('rewind', 15)
  })
  const toggleSubtitles = useLatestCallback(() => {
    revealControls()
    setSubtitlesEnabled((v) => !v)
  })
  // Holding the filament: keep the curtain up for the whole drag (the seek re-arms the auto-hide).
  const holdControls = useLatestCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    setShowControls(true)
  })
  const onFilmPress = useLatestCallback(() => (showControls ? setShowControls(false) : revealControls()))

  // ── layout + curtains ────────────────────────────────────────────────────────
  const cues = s.subtitle?.cues ?? NO_CUES
  const captionsOn = subtitlesEnabled && cues.length > 0
  const layout = useMemo(
    () =>
      playerLayout({
        width,
        height,
        insets,
        fontScale,
        bottomCurtainHeight: bottomCurtainH,
        topCurtainHeight: topCurtainH,
        captionsOn,
        captionHeight: captionH,
      }),
    [width, height, insets, fontScale, bottomCurtainH, topCurtainH, captionsOn, captionH],
  )
  const onBottomCurtainHeight = useCallback((h: number) => {
    setBottomCurtainH((prev) => (Math.abs(prev - h) > 1 ? Math.round(h) : prev))
  }, [])
  const onTopCurtainHeight = useCallback((h: number) => {
    setTopCurtainH((prev) => (Math.abs(prev - h) > 1 ? Math.round(h) : prev))
  }, [])
  // Only a caption block TALLER than the default reservation changes the budget, so ordinary
  // one/two-line cues never re-render the screen.
  const captionFloorPx = layout.captionFloor
  const onCaptionHeight = useCallback(
    (h: number) => {
      const next = h > captionFloorPx ? Math.round(h) : 0
      setCaptionH((prev) => (Math.abs(prev - next) > 1 ? next : prev))
    },
    [captionFloorPx],
  )

  const chromeOpen = showControls || ended
  const curtain = useSharedValue(1)
  useEffect(() => {
    curtain.value = withTiming(chromeOpen ? 1 : 0, { duration: motion.base, easing: Easing.bezier(...motion.expoOut) })
  }, [chromeOpen, curtain])
  const liftPx = useSharedValue(layout.lift)
  useEffect(() => {
    liftPx.value = layout.lift
  }, [layout.lift, liftPx])
  const lift = useDerivedValue(() => curtain.value * liftPx.value)
  // The social band's budget for the chrome state we're in (or heading to).
  const band = chromeOpen ? layout.social.open : layout.social.closed

  // ── status ──────────────────────────────────────────────────────────────────
  const failed = nativeStatus === 'error'
  const tag: { label: string; tone: SyncTone } = ended
    ? { label: 'THE END', tone: 'quiet' }
    : failed
      ? { label: 'SNAGGED', tone: 'danger' }
      : s.reconnecting
        ? { label: 'RECONNECTING…', tone: 'danger' }
        : buffering
          ? { label: everReady ? 'BUFFERING…' : 'THREADING…', tone: 'amber' }
          : isHost
            ? { label: 'HOSTING', tone: 'cyan' }
            : inSync
              ? { label: 'IN SYNC', tone: 'cyan' }
              : { label: 'CATCHING UP', tone: 'amber' }

  const requestPending = s.playbackRequestStatus === 'pending'
  const cacheBytes = s.cacheStatus?.totalBytes ?? 0
  const moderation = isHost ? (s.pendingPlaybackRequests[0] ?? null) : null

  // The line above the filament: the end, a hold for stragglers, or the host's pause.
  let notice: ReactNode = null
  if (ended) {
    notice = (
      <View style={[styles.noticeCol, layout.wide && styles.noticeInline]}>
        <FlapText value="THE END" size={22} />
        {cacheBytes > 0 ? (
          <IconButton
            variant="ghost"
            size={40}
            label={`Free up ${formatBytes(cacheBytes)}`}
            icon={(c) => <Trash2 size={15} color={c} strokeWidth={2} />}
            accessibilityLabel={`Free up ${formatBytes(cacheBytes)} of storage`}
            onPress={() => {
              revealControls()
              setDeleteError(null)
              setShowCleanupSheet(true)
            }}
          />
        ) : null}
      </View>
    )
  } else if (isHost && waiting.length > 0) {
    notice = playing ? (
      <Text variant="data" tone="secondary" style={styles.noticeText} numberOfLines={2}>
        {`Playing on without ${waiting.join(', ')} — they'll catch up`}
      </Text>
    ) : (
      <View style={[styles.noticeCol, layout.wide && styles.noticeInline]}>
        <Text variant="data" tone="secondary" style={styles.noticeText} numberOfLines={2}>
          {`Holding for ${waiting.join(', ')} to catch up…`}
        </Text>
        <Button title={`Play without ${waiting.length > 1 ? 'them' : waiting[0]}`} intent="neutral" height={44} onPress={playWithout} />
      </View>
    )
  } else if (!isHost && playback && !playback.isPlaying) {
    notice = (
      <Text variant="data" tone="secondary" style={styles.noticeText}>
        Paused by host
      </Text>
    )
  }

  const transport = isHost ? (
    <View style={[styles.transport, layout.wide && styles.transportWide]}>
      <IconButton
        variant="plain"
        size={52}
        icon={(c) => <RotateCcw size={26} color={c} strokeWidth={2} />}
        accessibilityLabel={`Back ${SKIP_SEC} seconds, for everyone`}
        onPress={skipBack}
      />
      <IconButton
        variant="amber"
        size={64}
        icon={(c) => (playing ? <Pause size={28} color={c} strokeWidth={2.5} /> : <Play size={28} color={c} strokeWidth={2.5} />)}
        accessibilityLabel={playing ? 'Pause for everyone' : 'Play for everyone'}
        onPress={togglePlay}
      />
      <IconButton
        variant="plain"
        size={52}
        icon={(c) => <RotateCw size={26} color={c} strokeWidth={2} />}
        accessibilityLabel={`Forward ${SKIP_SEC} seconds, for everyone`}
        onPress={skipForward}
      />
    </View>
  ) : ended ? (
    <View />
  ) : (
    <View style={styles.requests}>
      <IconButton
        variant="glass"
        size={40}
        label="Ask to pause"
        disabled={requestPending}
        icon={(c) => <Pause size={14} color={requestPending ? c : t.palette.amber} strokeWidth={2} />}
        accessibilityLabel="Ask the host to pause"
        onPress={askPause}
      />
      <IconButton
        variant="glass"
        size={40}
        label="Rewind 15s"
        disabled={requestPending}
        icon={(c) => <RotateCcw size={14} color={requestPending ? c : t.palette.amber} strokeWidth={2} />}
        accessibilityLabel="Ask the host to rewind 15 seconds"
        onPress={askRewind}
      />
    </View>
  )

  const rail = (
    <ReactionRail onReact={onReact} onOpenChat={openChat} unread={unread} keySize={layout.railKey} chatButtonRef={chatButtonRef} />
  )
  const scrubber = (
    <Scrubber playhead={playhead} durationSec={durationSec} interactive={isHost} onSeek={seekHost} onScrubStart={holdControls} />
  )
  const sidePad = { paddingLeft: layout.sideLeft, paddingRight: layout.sideRight }

  return (
    <View style={styles.fill}>
      {/* Everything under the chat sheet / error card; hidden from TalkBack while either modal layer is up. */}
      <View style={StyleSheet.absoluteFill} importantForAccessibility={chatOpen || failed ? 'no-hide-descendants' : 'auto'}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onFilmPress}
          accessibilityRole="button"
          accessibilityLabel={chromeOpen ? 'Hide controls' : 'Show controls'}
        >
          <VideoView style={StyleSheet.absoluteFill} player={player} contentFit="contain" nativeControls={false} />
        </Pressable>

        <PlayerStatusOverlay
          state={buffering && !ended ? 'loading' : 'ok'}
          firstLoad={!everReady}
          isHost={isHost}
          onRetry={retryPlayback}
          onLeave={leaveToLobby}
        />

        {/* the middle band: captions low and centred; chat ticker left and reactions right above them.
            All rest near the bottom and lift together, on the UI thread, when the curtain opens. */}
        <CaptionOverlay
          cues={cues}
          playhead={playhead}
          visible={subtitlesEnabled}
          bottomOffset={layout.captionBottom}
          left={layout.sideLeft + 4}
          right={layout.sideRight + 4}
          lift={lift}
          onHeight={onCaptionHeight}
        />
        {!chatOpen && band.ticker && (
          <ChatTicker
            log={chatLog}
            bottom={layout.socialBottom}
            left={layout.sideLeft}
            right={band.tickerRight}
            maxHeight={band.tickerMaxHeight}
            lift={lift}
          />
        )}
        <FloatingReactions
          reactions={s.reactions}
          bottom={layout.socialBottom}
          right={layout.sideRight}
          lanes={band.reactions}
          lift={lift}
        />

        <Curtain edge="top" progress={curtain} open={chromeOpen} onHeight={onTopCurtainHeight}>
          <View style={[styles.topBar, sidePad, { paddingTop: insets.top + 10 }]} pointerEvents="box-none">
            <IconButton
              variant="glass"
              size={44}
              icon={(c) => <ChevronLeft size={20} color={c} strokeWidth={2.25} />}
              accessibilityLabel={ended ? 'Leave the show' : 'Back to the lobby'}
              onPress={leaveToLobby}
            />
            <View style={styles.titleCol} accessible accessibilityRole="header">
              <Text variant="eyebrow" tone="amber" numberOfLines={1}>
                {isHost ? 'NOW SHOWING · HOST' : 'NOW SHOWING'}
              </Text>
              {s.movie?.title ? (
                <Text variant="caption" tone="primary" numberOfLines={1}>
                  {s.movie.title}
                </Text>
              ) : null}
            </View>
            {s.subtitle ? (
              <IconButton
                variant="glass"
                size={44}
                selected={subtitlesEnabled}
                haptic="selection"
                icon={(c) => <Subtitles size={18} color={c} strokeWidth={2} />}
                accessibilityLabel="Subtitles"
                accessibilityHint={subtitlesEnabled ? 'Turns subtitles off' : 'Turns subtitles on'}
                onPress={toggleSubtitles}
              />
            ) : null}
            <SyncTag label={tag.label} tone={tag.tone} />
          </View>
        </Curtain>

        <Curtain edge="bottom" progress={curtain} open={chromeOpen} onHeight={onBottomCurtainHeight}>
          <View style={[styles.bottomBar, sidePad, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none">
            {notice ? <View style={styles.noticeRow}>{notice}</View> : null}
            {layout.wide ? (
              <>
                {scrubber}
                <View style={styles.wideRow} pointerEvents="box-none">
                  {transport}
                  {rail}
                </View>
              </>
            ) : (
              <>
                {rail}
                {scrubber}
                {transport}
              </>
            )}
          </View>
        </Curtain>
      </View>

      {failed ? (
        <PlayerStatusOverlay
          state="error"
          firstLoad={!everReady}
          isHost={isHost}
          detail={playerError}
          onRetry={retryPlayback}
          onLeave={leaveToLobby}
        />
      ) : null}

      <ChatSheet visible={chatOpen} log={chatLog} onSend={sendChat} onClose={closeChat} reconnecting={s.reconnecting} />

      {/* Time-boxed host prompt and guest feedback sit above even the chat: they expire on their own. */}
      {moderation ? (
        <View style={[styles.topLayer, sidePad, { top: layout.bannerTop }]} pointerEvents="box-none">
          <ModerationBanner request={moderation} onApprove={approveRequest} onDismiss={dismissRequest} />
        </View>
      ) : null}
      {!isHost && s.playbackRequestStatus !== 'idle' ? (
        <View style={[styles.topLayer, styles.centered, sidePad, { top: layout.bannerTop }]} pointerEvents="none">
          <RequestFeedbackToast status={s.playbackRequestStatus} onDismiss={clearPlaybackRequestStatus} />
        </View>
      ) : null}

      <CleanupSheet
        visible={showCleanupSheet}
        totalBytes={cacheBytes}
        movieBytes={s.cacheStatus?.movieBytes}
        subtitleBytes={s.cacheStatus?.subtitleBytes}
        onDeleteAndLeave={handleDeleteAndLeave}
        onKeepAndLeave={handleKeepAndLeave}
        onCancel={() => setShowCleanupSheet(false)}
        isDeleting={isDeleting}
        error={deleteError}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: palette.black },
  // paddingBottom is the curtain's fade below the controls — the layout's TOP_FADE.
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: TOP_FADE },
  titleCol: { flex: 1, minWidth: 0 },
  bottomBar: { paddingTop: 36, gap: 10 },
  noticeRow: { alignItems: 'center' },
  noticeCol: { alignItems: 'center', gap: 10 },
  // Landscape: notice and its action share a line, so the bottom curtain stays short.
  noticeInline: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 16 },
  noticeText: { textAlign: 'center', flexShrink: 1 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 32 },
  transportWide: { gap: 20, justifyContent: 'flex-start' },
  requests: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' },
  wideRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  topLayer: { position: 'absolute', left: 0, right: 0, zIndex: 110, elevation: 110 },
  centered: { alignItems: 'center' },
})
