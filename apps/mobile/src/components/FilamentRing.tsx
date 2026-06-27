import { useEffect, type ReactNode } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg'
import Animated, {
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import { Check } from 'lucide-react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * A circular buffer/readiness meter drawn as a glowing tungsten filament: a soft wide
 * amber stroke behind a sharp gradient stroke that fills as `progress` (0–1) climbs, and
 * "ignites" (a check) at 100%. See docs/design-language.md.
 */

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

export function FilamentRing({
  progress,
  size = 92,
  stroke = 5,
  children,
}: {
  progress: number
  size?: number
  stroke?: number
  children?: ReactNode
}) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const p = useSharedValue(0)
  const r = (size - stroke * 2) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(1, progress))
  const ready = clamped >= 1
  const pct = Math.round(clamped * 100)

  useEffect(() => {
    p.value = reduced ? clamped : withTiming(clamped, { duration: 700, easing: Easing.out(Easing.cubic) })
  }, [clamped, reduced, p])

  const animatedProps = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - p.value) }))

  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessible
      accessibilityLabel={ready ? 'ready' : `${pct} percent`}
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <LinearGradient id="filament" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={t.palette.amberGlow} />
            <Stop offset="1" stopColor={t.palette.amberCore} />
          </LinearGradient>
        </Defs>
        {/* track */}
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.palette.hairline} strokeWidth={stroke} fill="none" />
        {/* soft filament glow */}
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={t.palette.amber}
          strokeWidth={stroke * 2.4}
          strokeOpacity={0.18}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {/* sharp filament */}
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#filament)"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children ??
        (ready ? (
          <Check size={size * 0.34} color={t.palette.amber} strokeWidth={2.5} />
        ) : (
          <Text variant="data" tone="secondary">
            {pct}
          </Text>
        ))}
    </View>
  )
}
