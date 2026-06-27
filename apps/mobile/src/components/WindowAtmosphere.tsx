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
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * The night-train window: cold light-streaks drifting at parallax depths behind
 * everything, under a cinema vignette (radial edge darken + top/bottom letterbox).
 * Ambient brand atmosphere — `intensity` scales it (Home high, Player low; 0 = off).
 * Halts under reduce-motion. See docs/design-language.md.
 */

type Streak = {
  topPct: number
  height: number
  widthPct: number
  durationMs: number
  delayMs: number
  warm: boolean
  opacity: number
}

const STREAKS: Streak[] = [
  { topPct: 0.14, height: 2, widthPct: 0.8, durationMs: 9000, delayMs: 0, warm: false, opacity: 0.9 },
  { topPct: 0.33, height: 1, widthPct: 0.6, durationMs: 14000, delayMs: 1800, warm: true, opacity: 0.7 },
  { topPct: 0.5, height: 4, widthPct: 0.95, durationMs: 6500, delayMs: 600, warm: false, opacity: 1 },
  { topPct: 0.68, height: 1, widthPct: 0.55, durationMs: 15000, delayMs: 2600, warm: true, opacity: 0.6 },
  { topPct: 0.84, height: 2, widthPct: 0.75, durationMs: 11000, delayMs: 1200, warm: false, opacity: 0.8 },
]

export function WindowAtmosphere({ intensity = 1 }: { intensity?: number }) {
  const t = useTheme()
  const active = intensity > 0
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.palette.base }]} pointerEvents="none">
      {active
        ? STREAKS.map((s, i) => <StreakBar key={i} streak={s} intensity={intensity} />)
        : null}

      {/* Radial edge/corner darken — the glass curving into the dark. */}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="vig" cx="50%" cy="42%" rx="75%" ry="75%">
            <Stop offset="55%" stopColor={t.palette.void} stopOpacity={0} />
            <Stop offset="100%" stopColor={t.palette.void} stopOpacity={0.92} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#vig)" />
      </Svg>

      {/* Cinematic top/bottom letterbox darken. */}
      <LinearGradient colors={t.gradients.vignette} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
    </View>
  )
}

function StreakBar({ streak, intensity }: { streak: Streak; intensity: number }) {
  const t = useTheme()
  const { width } = useWindowDimensions()
  const reduced = useReducedMotion()
  const travel = width * 1.7
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
          width: width * streak.widthPct,
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
