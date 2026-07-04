import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { Text } from '@/ui'
import { reactionLane, type ReactionEvent } from '@/lib/social/feed'

/**
 * Floating reactions: warm sparks drifting up the RIGHT edge of the film — visible, never over
 * the actors' faces. Each is small (emoji + sender in tiny mono), rises and fades in ~2.5s, and
 * at most a handful ride at once (lanes are assigned deterministically by sequence). Under
 * reduce-motion they fade in place instead of travelling. See docs/design-language.md.
 */

const LIFE_MS = 2500
const RISE_PX = 170
const MAX_CONCURRENT = 4
const LANE_STEP_PX = 54

export function FloatingReactions({ reactions }: { reactions: ReactionEvent[] }) {
  const [visible, setVisible] = useState<ReactionEvent[]>([])
  const lastSeqRef = useRef(0)

  // Adopt only NEW events from the store (it keeps a longer tail than we animate).
  useEffect(() => {
    const fresh = reactions.filter((r) => r.seq > lastSeqRef.current)
    if (fresh.length === 0) return
    lastSeqRef.current = reactions[reactions.length - 1]?.seq ?? lastSeqRef.current
    setVisible((v) => [...v, ...fresh].slice(-MAX_CONCURRENT))
  }, [reactions])

  const retire = (seq: number) => setVisible((v) => v.filter((r) => r.seq !== seq))

  return (
    <View pointerEvents="none" style={styles.lane}>
      {visible.map((r) => (
        <Spark key={r.seq} event={r} onDone={retire} />
      ))}
    </View>
  )
}

function Spark({ event, onDone }: { event: ReactionEvent; onDone: (seq: number) => void }) {
  const reduced = useReducedMotion()
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withTiming(1, { duration: LIFE_MS, easing: Easing.out(Easing.quad) })
    const id = setTimeout(() => onDone(event.seq), LIFE_MS + 60)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const style = useAnimatedStyle(() => {
    const p = progress.value
    // Bright quickly, hold, then melt away in the last third.
    const opacity = p < 0.12 ? p / 0.12 : p > 0.66 ? (1 - p) / 0.34 : 1
    return {
      opacity,
      transform: [
        { translateY: reduced ? 0 : -RISE_PX * p },
        { scale: 0.7 + 0.3 * Math.min(1, p * 6) },
      ],
    }
  })

  const lane = reactionLane(event.seq)
  return (
    <Animated.View style={[styles.spark, { bottom: 140 + lane * LANE_STEP_PX }, style]}>
      <Text style={styles.emoji}>{event.emoji}</Text>
      <Text variant="data" tone="tertiary" style={styles.name} numberOfLines={1}>
        {event.from.toLowerCase()}
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  lane: { ...StyleSheet.absoluteFill as object },
  spark: { position: 'absolute', right: 14, alignItems: 'center', maxWidth: 92 },
  emoji: { fontSize: 30, lineHeight: 36 },
  name: { fontSize: 10, marginTop: -2 },
})
