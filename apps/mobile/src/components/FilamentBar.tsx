import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

/**
 * A horizontal tungsten filament: the FilamentRing's progress motif laid flat for the boarding
 * manifest. A warm amber fill glides across a cold track and glows brighter as it ignites toward
 * 100%. Static under reduce-motion. See docs/design-language.md.
 */
export function FilamentBar({ progress, height = 8 }: { progress: number; height?: number }) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const p = useSharedValue(clamp01(progress))

  useEffect(() => {
    p.value = reduced ? clamp01(progress) : withTiming(clamp01(progress), { duration: motion.base })
  }, [progress, reduced, p])

  const fillStyle = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }))
  // The leading edge burns brightest — a filament tip glow that grows as the bar fills.
  const tipStyle = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * p.value }))

  return (
    <View style={[styles.track, { height, borderRadius: height, backgroundColor: t.palette.base, borderColor: t.palette.hairline }]}>
      <Animated.View style={[styles.fill, { borderRadius: height }, fillStyle]}>
        <LinearGradient
          colors={[t.palette.amberDeep, t.palette.amber, t.palette.amberGlow]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={[styles.tip, { backgroundColor: t.palette.amberGlow, shadowColor: t.palette.amber }, tipStyle]} />
      </Animated.View>
    </View>
  )
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  fill: { height: '100%', overflow: 'hidden' },
  tip: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 3,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
  },
})
