import { useEffect } from 'react'
import { StyleSheet, type ViewStyle } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

/**
 * The filament glow from the design language: a radial `amber.glow@40% → transparent` bloom that
 * sits BEHIND a CTA. Restrained by default (a slow breath); `lit` drives it brighter for a
 * moment like Start igniting at "all aboard". Decorative: never intercepts touches. Static under
 * reduce-motion. See docs/design-language.md.
 */
export function FilamentBloom({
  lit = true,
  breathe = false,
  peak = 1,
  style,
}: {
  /** Whether the bloom is on (fades in/out). */
  lit?: boolean
  /** A slow ambient breath while lit (Home's primary CTA). */
  breathe?: boolean
  /** Max opacity multiplier (0–1). */
  peak?: number
  /** Position/size it around the control it backs (negative insets bleed past the edges). */
  style?: ViewStyle
}) {
  const t = useTheme()
  const reduced = useReduceMotion()
  const v = useSharedValue(0)

  useEffect(() => {
    if (!lit) {
      v.value = reduced ? 0 : withTiming(0, { duration: motion.base })
      return
    }
    if (reduced) {
      v.value = 0.75
      return
    }
    if (breathe) {
      v.value = withTiming(0.7, { duration: motion.slow, easing: Easing.bezier(...motion.expoOut) }, (done) => {
        if (!done) return
        v.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
            withTiming(0.62, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
          ),
          -1,
          false,
        )
      })
    } else {
      v.value = withSequence(withTiming(1, { duration: 260 }), withTiming(0.75, { duration: 1100 }))
    }
    return () => cancelAnimation(v)
  }, [lit, breathe, reduced, v])

  const animated = useAnimatedStyle(() => ({ opacity: v.value * peak }))

  return (
    <Animated.View pointerEvents="none" style={[styles.fill, style, animated]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="bloom" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0%" stopColor={t.palette.amberGlow} stopOpacity={0.4} />
            <Stop offset="100%" stopColor={t.palette.amberGlow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#bloom)" />
      </Svg>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
})
