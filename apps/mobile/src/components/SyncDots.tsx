import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * Three dots that breathe in sequence — a quiet "offline network" / sync indicator
 * (cyan = connection/proximity in the system). Earns its place as information, not
 * decoration. Static under reduce-motion. See docs/design-language.md.
 */
export function SyncDots({ count = 3 }: { count?: number }) {
  return (
    <View style={styles.row}>
      {Array.from({ length: count }).map((_, i) => (
        <Dot key={i} index={i} />
      ))}
    </View>
  )
}

function Dot({ index }: { index: number }) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const v = useSharedValue(0.25)

  useEffect(() => {
    if (reduced) {
      v.value = 0.5
      return
    }
    v.value = withDelay(
      index * 260,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 620, easing: Easing.out(Easing.quad) }),
          withTiming(0.25, { duration: 900, easing: Easing.in(Easing.quad) }),
        ),
        -1,
        false,
      ),
    )
    return () => cancelAnimation(v)
  }, [reduced, index, v])

  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + v.value * 0.55,
    transform: [{ scale: 0.85 + v.value * 0.35 }],
  }))

  return <Animated.View style={[styles.dot, { backgroundColor: t.palette.cyan }, style]} />
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
})
