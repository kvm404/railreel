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
import { LANE_STEP_X, LANE_STEP_Y, MAX_LANES, SPARK_RISE, SPARK_W, type ReactionLanes } from '@/lib/player/layout'

/**
 * Floating reactions: warm sparks drifting up the RIGHT edge of the film — visible, never over
 * the actors' faces. Each is small (emoji + sender in tiny mono), rises and fades in ~2.5s, and
 * at most a handful ride at once (lanes are assigned deterministically by sequence).
 *
 * The lane plan (vertical column, or spread sideways on a short viewport, and how many) comes from
 * the Player's layout (lib/player/layout reactionLanes) so the chat ticker keeps a readable width.
 * Under reduce-motion a spark simply appears in its lane and stays put, fully visible, for its
 * lifetime. See docs/design-language.md.
 */

const LIFE_MS = 2500
const DEFAULT_LANES: ReactionLanes = { axis: 'vertical', count: MAX_LANES, rise: SPARK_RISE, span: SPARK_W }

export const FloatingReactions = memo(function FloatingReactions({
  reactions,
  bottom = 140,
  right = 14,
  lanes = DEFAULT_LANES,
  lift,
}: {
  reactions: ReactionEvent[]
  /** Where the lowest lane starts (px from the bottom). */
  bottom?: number
  right?: number
  lanes?: ReactionLanes
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
    setVisible((v) => [...v, ...fresh].slice(-MAX_LANES))
  }, [reactions])

  const retire = useCallback((seq: number) => setVisible((v) => v.filter((r) => r.seq !== seq)), [])
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift ? -lift.value : 0 }] }))

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, liftStyle]}>
      {visible.map((r) => {
        const lane = reactionLane(r.seq, lanes.count)
        const place =
          lanes.axis === 'sideways'
            ? { bottom, right: right + lane * LANE_STEP_X }
            : { bottom: bottom + lane * LANE_STEP_Y, right }
        return <Spark key={r.seq} event={r} rise={lanes.rise} place={place} onDone={retire} />
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
  spark: { position: 'absolute', alignItems: 'center', maxWidth: SPARK_W },
  emoji: { fontSize: 30, lineHeight: 36 },
  name: { fontSize: 10, marginTop: -2, textShadowRadius: 4 },
})
