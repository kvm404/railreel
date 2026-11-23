import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { reactionLane, type ReactionEvent } from '@/lib/social/feed'

/**
 * Floating reactions: warm sparks drifting up the RIGHT edge of the film — visible, never over
 * the actors' faces. Each is small (emoji + sender in tiny mono), rises and fades in ~2.5s, and
 * at most a handful ride at once (lanes are assigned deterministically by sequence).
 *
 * Lanes stack vertically when there's height for it; on a short (landscape) viewport they spread
 * sideways instead so the column never runs off the top. Under reduce-motion a spark simply
 * appears in its lane and stays put, fully visible, for its lifetime. See docs/design-language.md.
 */

const LIFE_MS = 2500
const RISE_PX = 170
const MAX_CONCURRENT = 4
const LANE_STEP_PX = 54
const LANE_STEP_X = 52
/** Below this much vertical room, lanes go side by side. */
const TALL_ENOUGH_PX = RISE_PX + LANE_STEP_PX * (MAX_CONCURRENT - 1) + 48

export const FloatingReactions = memo(function FloatingReactions({
  reactions,
  bottom = 140,
  right = 14,
  room = Infinity,
  lift,
}: {
  reactions: ReactionEvent[]
  /** Where the lowest lane starts (px from the bottom). */
  bottom?: number
  right?: number
  /** Vertical room available above `bottom` (px). */
  room?: number
  /** Extra upward offset (px), animated with the chrome curtain. */
  lift?: SharedValue<number>
}) {
  const [visible, setVisible] = useState<ReactionEvent[]>([])
  const lastSeqRef = useRef(0)

  // Adopt only NEW events from the store (it keeps a longer tail than we animate).
  useEffect(() => {
    const fresh = reactions.filter((r) => r.seq > lastSeqRef.current)
    if (fresh.length === 0) return
    lastSeqRef.current = reactions[reactions.length - 1]?.seq ?? lastSeqRef.current
    setVisible((v) => [...v, ...fresh].slice(-MAX_CONCURRENT))
  }, [reactions])

  const retire = useCallback((seq: number) => setVisible((v) => v.filter((r) => r.seq !== seq)), [])
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift ? -lift.value : 0 }] }))

  const sideways = room < TALL_ENOUGH_PX
  const rise = sideways ? Math.max(60, Math.min(RISE_PX, room - 48)) : RISE_PX

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, liftStyle]}>
      {visible.map((r) => {
        const lane = reactionLane(r.seq, MAX_CONCURRENT)
        const place = sideways
          ? { bottom, right: right + lane * LANE_STEP_X }
          : { bottom: bottom + lane * LANE_STEP_PX, right }
        return <Spark key={r.seq} event={r} rise={rise} place={place} onDone={retire} />
      })}
    </Animated.View>
  )
})

function Spark({
  event,
  rise,
  place,
  onDone,
}: {
  event: ReactionEvent
  rise: number
  place: { bottom: number; right: number }
  onDone: (seq: number) => void
}) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const progress = useSharedValue(0)

  useEffect(() => {
    // mount-only: this spark animates once and retires itself; event.seq is stable per instance.
    // Reduced motion: no tween at all (withTiming would jump straight to the faded end state) —
    // the static spark below just holds for its life.
    if (!reduced) progress.value = withTiming(1, { duration: LIFE_MS, easing: Easing.out(Easing.quad) })
    const id = setTimeout(() => onDone(event.seq), LIFE_MS + 60)
    return () => clearTimeout(id)
  }, [])

  const style = useAnimatedStyle(() => {
    if (reduced) return { opacity: 1, transform: [] }
    const p = progress.value
    // Bright quickly, hold, then melt away in the last third.
    const opacity = p < 0.12 ? p / 0.12 : p > 0.66 ? (1 - p) / 0.34 : 1
    return {
      opacity,
      transform: [{ translateY: -rise * p }, { scale: 0.7 + 0.3 * Math.min(1, p * 6) }],
    }
  })

  return (
    <Animated.View style={[styles.spark, place, style]}>
      <Text style={styles.emoji}>{event.emoji}</Text>
      <Text variant="data" style={[styles.name, { color: t.palette.textSecondary, textShadowColor: t.palette.void }]} numberOfLines={1}>
        {event.from.toLowerCase()}
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  spark: { position: 'absolute', alignItems: 'center', maxWidth: 92 },
  emoji: { fontSize: 30, lineHeight: 36 },
  name: { fontSize: 10, marginTop: -2, textShadowRadius: 4 },
})
