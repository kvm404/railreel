import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { LinearGradient } from 'expo-linear-gradient'
import * as Haptics from 'expo-haptics'
import { Text } from '@/ui'
import { withAlpha } from '@/ui/alpha'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'
import { usePlayheadSecond, type Playhead } from '@/hooks/usePlayhead'
import { fmtTime, spokenTime as spoken } from '@/lib/player/time'

/**
 * The filament timeline: a cold hairline track with a tungsten (amber → core) fill and a glowing
 * tip. Fill and tip are driven from the playhead's shared value on the UI thread — no React
 * render per tick; only the mono timecodes re-render, once a second.
 *
 * Host: drag (or tap) anywhere on the track to scrub; the tip swells while held, the timecode
 * follows the finger, and the seek is committed once on release (the caller broadcasts it via
 * the normal host-playback path). TalkBack gets an adjustable control (swipe up/down = ±10s).
 * Guests: the same filament, read-only, exposed as a progress bar with a spoken position.
 */

const TRACK_H = 3
const HIT_H = 36
const TIP = 12
const TIP_HELD = 20
const TIP_GUEST = 7 // guests get a small non-grabbable spark — nothing suggests they can drag
const A11Y_STEP_SEC = 10
/** Throttle for the finger-following timecode (JS), so a fast drag isn't a JS call per frame. */
const LABEL_THROTTLE_MS = 80

export const Scrubber = memo(function Scrubber({
  playhead,
  durationSec,
  interactive,
  onSeek,
  onScrubStart,
}: {
  playhead: Playhead
  durationSec: number
  interactive: boolean
  onSeek?: (sec: number) => void
  /** The user started holding the filament (keep the chrome up). */
  onScrubStart?: () => void
}) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const second = usePlayheadSecond(playhead)
  const [scrubSec, setScrubSec] = useState<number | null>(null)

  const sv = playhead.sv // captured by the worklets below (never the whole playhead object)
  const trackW = useSharedValue(0)
  const duration = useSharedValue(durationSec)
  useEffect(() => {
    duration.value = durationSec
  }, [durationSec, duration])
  const held = useSharedValue(0) // 0..1 (tip swell)
  const scrubbing = useSharedValue(false)
  const scrubP = useSharedValue(0)
  const lastLabelAt = useSharedValue(0)

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      trackW.value = e.nativeEvent.layout.width
    },
    [trackW],
  )

  const startScrub = useCallback(() => {
    Haptics.selectionAsync().catch(() => {})
    onScrubStart?.()
  }, [onScrubStart])
  const commit = useCallback(
    (p: number) => {
      setScrubSec(null)
      if (durationSec > 0) onSeek?.(p * durationSec)
    },
    [durationSec, onSeek],
  )
  const cancel = useCallback(() => setScrubSec(null), [])

  const enabled = interactive && durationSec > 0
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .minDistance(0)
        .hitSlop({ vertical: 6 })
        .onBegin((e) => {
          const w = trackW.value
          if (w <= 0) return
          scrubbing.value = true
          scrubP.value = Math.min(1, Math.max(0, e.x / w))
          held.value = reduced ? 1 : withSpring(1, motion.spring)
          runOnJS(startScrub)()
          runOnJS(setScrubSec)(scrubP.value * duration.value)
        })
        .onUpdate((e) => {
          const w = trackW.value
          if (w <= 0) return
          scrubP.value = Math.min(1, Math.max(0, e.x / w))
          const now = Date.now()
          if (now - lastLabelAt.value > LABEL_THROTTLE_MS) {
            lastLabelAt.value = now
            runOnJS(setScrubSec)(scrubP.value * duration.value)
          }
        })
        .onFinalize((_e, success) => {
          if (!scrubbing.value) return
          held.value = reduced ? 0 : withTiming(0, { duration: motion.fast })
          // Keep showing the scrub point until the playhead catches up (the store holds stale ticks).
          if (success) sv.value = scrubP.value * duration.value
          scrubbing.value = false
          if (success) runOnJS(commit)(scrubP.value)
          else runOnJS(cancel)()
        }),
    [enabled, reduced, trackW, scrubbing, scrubP, held, duration, lastLabelAt, sv, startScrub, commit, cancel],
  )

  const progressStyle = useAnimatedStyle(() => {
    const d = duration.value
    const p = scrubbing.value ? scrubP.value : d > 0 ? Math.min(1, Math.max(0, sv.value / d)) : 0
    return { transform: [{ scaleX: p }] }
  })
  const tipStyle = useAnimatedStyle(() => {
    const d = duration.value
    const p = scrubbing.value ? scrubP.value : d > 0 ? Math.min(1, Math.max(0, sv.value / d)) : 0
    const size = interactive ? TIP + (TIP_HELD - TIP) * held.value : TIP_GUEST
    return {
      width: size,
      height: size,
      borderRadius: size / 2,
      top: (HIT_H - size) / 2,
      transform: [{ translateX: p * trackW.value - size / 2 }],
    }
  })

  // TalkBack: adjustable for the host (±10s per swipe), progress bar for guests.
  const onA11yAction = useCallback(
    (e: AccessibilityActionEvent) => {
      if (!interactive || durationSec <= 0) return
      const base = playhead.get()
      const delta = e.nativeEvent.actionName === 'increment' ? A11Y_STEP_SEC : e.nativeEvent.actionName === 'decrement' ? -A11Y_STEP_SEC : 0
      if (!delta) return
      const to = Math.min(durationSec, Math.max(0, base + delta))
      onSeek?.(to)
    },
    [interactive, durationSec, playhead, onSeek],
  )

  const shown = scrubSec ?? second
  const hasDuration = durationSec > 0
  const a11yText = hasDuration ? `${spoken(shown)} of ${spoken(durationSec)}` : spoken(shown)

  return (
    <View style={styles.row}>
      <Text variant="data" tone={scrubSec != null ? 'amber' : 'secondary'} style={styles.time}>
        {fmtTime(shown)}
      </Text>
      <GestureDetector gesture={pan}>
        <View
          style={styles.hit}
          onLayout={onLayout}
          accessible
          accessibilityRole={interactive ? 'adjustable' : 'progressbar'}
          accessibilityLabel={interactive ? 'Seek through the movie' : 'Movie progress'}
          accessibilityHint={interactive ? 'Swipe up or down to skip ten seconds, for everyone' : undefined}
          accessibilityValue={hasDuration ? { min: 0, max: Math.round(durationSec), now: Math.round(shown), text: a11yText } : { text: a11yText }}
          accessibilityActions={interactive ? [{ name: 'increment' }, { name: 'decrement' }] : undefined}
          onAccessibilityAction={onA11yAction}
        >
          <View style={[styles.track, { backgroundColor: withAlpha(t.palette.textPrimary, 0.16) }]}>
            <Animated.View style={[styles.fill, progressStyle]}>
              <LinearGradient
                colors={[t.palette.amber, t.palette.amberCore]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </View>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tip,
              {
                backgroundColor: interactive ? t.palette.amberGlow : t.palette.amber,
                shadowColor: t.palette.amber,
                borderColor: withAlpha(t.palette.amberGlow, 0.5),
              },
              tipStyle,
            ]}
          />
        </View>
      </GestureDetector>
      <Text variant="data" tone="secondary" style={styles.time}>
        {hasDuration ? fmtTime(durationSec) : '--:--'}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  time: { fontSize: 12, minWidth: 44, textAlign: 'center', fontVariant: ['tabular-nums'] },
  hit: { flex: 1, height: HIT_H, justifyContent: 'center' },
  track: { height: TRACK_H, borderRadius: TRACK_H, overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFill, transformOrigin: 'left' },
  tip: {
    position: 'absolute',
    left: 0,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 4,
  },
})
