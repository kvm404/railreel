import { useEffect } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * The night-train window: cold light-streaks drifting at parallax depths behind
 * everything, under a cinema vignette. Ambient brand atmosphere — `intensity`
 * scales it (Home high, Player low). Halts under reduce-motion.
 * See docs/design-language.md.
 */

type Streak = {
  topPct: number
  height: number
  durationMs: number
  delayMs: number
  warm: boolean
  opacity: number
}

const STREAKS: Streak[] = [
  { topPct: 0.16, height: 2, durationMs: 9000, delayMs: 0, warm: false, opacity: 0.9 },
  { topPct: 0.34, height: 1, durationMs: 14000, delayMs: 1800, warm: true, opacity: 0.7 },
  { topPct: 0.62, height: 3, durationMs: 7000, delayMs: 600, warm: false, opacity: 1 },
  { topPct: 0.8, height: 1, durationMs: 16000, delayMs: 2600, warm: true, opacity: 0.6 },
]

export function WindowAtmosphere({ intensity = 1 }: { intensity?: number }) {
  const t = useTheme()
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.palette.base }]} pointerEvents="none">
      {STREAKS.map((s, i) => (
        <StreakBar key={i} streak={s} intensity={intensity} />
      ))}
      {/* Cinematic top/bottom darken. */}
      <LinearGradient
        colors={t.gradients.vignette}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  )
}

function StreakBar({ streak, intensity }: { streak: Streak; intensity: number }) {
  const t = useTheme()
  const { width } = useWindowDimensions()
  const reduced = useReducedMotion()
  const travel = width * 1.6
  const x = useSharedValue(-travel)

  useEffect(() => {
    if (reduced) {
      x.value = 0
      return
    }
    x.value = -travel
    x.value = withDelay(
      streak.delayMs,
      withRepeat(withTiming(travel, { duration: streak.durationMs, easing: Easing.linear }), -1, false),
    )
    return () => cancelAnimation(x)
  }, [reduced, travel, streak.delayMs, streak.durationMs, x])

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))

  const colors = streak.warm ? t.gradients.streakAmber : t.gradients.streakCyan

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: `${streak.topPct * 100}%`,
          left: 0,
          width: width * 0.7,
          height: streak.height,
          opacity: streak.opacity * intensity * (reduced ? 0.4 : 1),
        },
        style,
      ]}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  )
}
