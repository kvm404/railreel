import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { Text } from '@/ui'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { fonts } from '@/theme/tokens'
import { reactionLane, type ReactionEvent } from '@/lib/social/feed'
import { LANE_STEP_X, LANE_STEP_Y, MAX_LANES, SPARK_RISE, SPARK_W, type ReactionLanes } from '@/lib/player/layout'

/**
 * Floating reactions: warm sparks drifting up the RIGHT edge of the film — visible, never over
 * the actors' faces. Each is small (emoji + sender's name), rises and fades in ~2.5s, and at most a
 * handful ride at once (lanes are assigned deterministically by sequence).
 *
 * The lane plan (vertical column, or spread sideways on a short viewport, and how many) comes from
 * the Player's layout (lib/player/layout reactionLanes) so the chat ticker keeps a readable width;
 * `lanes={null}` means the budget has no room — nothing is drawn (the cursor still advances, so
 * nothing bursts out later). Only reactions that arrive while mounted animate: returning to the
 * Player never replays the store's tail. Under reduce-motion (read live) a spark simply appears in
 * its lane and stays put, fully visible, for its lifetime. See docs/design-language.md.
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
  /** null: no room in the current layout — draw nothing. */
  lanes?: ReactionLanes | null
  /** Extra upward offset (px), animated with the chrome curtain. */
  lift?: SharedValue<number>
}) {
  const [visible, setVisible] = useState<ReactionEvent[]>([])
  // Start at the store's existing tail: those reactions happened before this Player was on screen.
  const lastSeqRef = useRef(reactions[reactions.length - 1]?.seq ?? 0)

  // Adopt only NEW events from the store (it keeps a longer tail than we animate).
  useEffect(() => {
    const fresh = reactions.filter((r) => r.seq > lastSeqRef.current)
    if (fresh.length === 0) return
    lastSeqRef.current = reactions[reactions.length - 1]?.seq ?? lastSeqRef.current
    if (!lanes) return // no room right now: they pass unseen rather than queue up
    setVisible((v) => [...v, ...fresh].slice(-MAX_LANES))
  }, [reactions, lanes])

  // Losing the room mid-flight drops what's in the air (it would cross the header otherwise).
  useEffect(() => {
    if (!lanes) setVisible([])
  }, [lanes])

  const retire = useCallback((seq: number) => setVisible((v) => v.filter((r) => r.seq !== seq)), [])
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift ? -lift.value : 0 }] }))

  if (!lanes) return null

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
  const reduced = useReduceMotion()
  const progress = useSharedValue(0)

  useEffect(() => {
    // mount-only: this spark retires itself after its life; event.seq is stable per instance.
    const id = setTimeout(() => onDone(event.seq), LIFE_MS + 60)
    return () => clearTimeout(id)
  }, [])

  // The drift runs only while motion is allowed. Reduce-motion switched on mid-flight stops it
  // where it is and the static spark below holds for the rest of its life.
  useEffect(() => {
    if (reduced) {
      cancelAnimation(progress)
      return
    }
    const left = 1 - progress.value // resumes for the rest of its life if motion came back mid-flight
    if (left > 0) progress.value = withTiming(1, { duration: LIFE_MS * left, easing: Easing.out(Easing.quad) })
    return () => cancelAnimation(progress)
  }, [reduced, progress])

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
      <Text variant="caption" style={[styles.name, { color: t.palette.textSecondary, textShadowColor: t.palette.void }]} numberOfLines={1}>
        {event.from}
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  spark: { position: 'absolute', alignItems: 'center', maxWidth: SPARK_W },
  emoji: { fontSize: 30, lineHeight: 36 },
  name: { fontFamily: fonts.bodyMedium, fontSize: 11, lineHeight: 14, marginTop: -2, textShadowRadius: 4 },
})
