import { useEffect } from 'react'
import { StyleSheet, View, type ViewStyle } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useTheme } from '@/theme/ThemeProvider'
import { fonts, motion, palette } from '@/theme/tokens'

/**
 * The split-flap departure board — RailReel's signature element.
 *
 * Renders a string as a row of dark flap cells, each flipping into place (rotateX)
 * with a left→right cascade, like a Solari board. Used for join codes, counts,
 * statuses and countdowns. See docs/design-language.md.
 */

export type FlapTextProps = {
  value: string
  /** Glyph height; cell sizing derives from this. */
  size?: number
  tone?: 'primary' | 'amber' | 'cyan'
  /** Stagger between cells (ms). 0 flips all at once. */
  stagger?: number
  style?: ViewStyle
}

const TONE: Record<NonNullable<FlapTextProps['tone']>, string> = {
  primary: palette.textPrimary,
  amber: palette.amber,
  cyan: palette.cyan,
}

export function FlapText({
  value,
  size = 28,
  tone = 'primary',
  stagger = 40,
  style,
}: FlapTextProps) {
  const chars = value.split('')
  return (
    <View style={[styles.row, { gap: Math.max(2, size * 0.12) }, style]}>
      {chars.map((ch, i) => (
        <FlapCell key={`${i}-${ch}`} char={ch} index={i} size={size} stagger={stagger} color={TONE[tone]} />
      ))}
    </View>
  )
}

function FlapCell({
  char,
  index,
  size,
  stagger,
  color,
}: {
  char: string
  index: number
  size: number
  stagger: number
  color: string
}) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const rot = useSharedValue(reduced ? 0 : -90)
  const opacity = useSharedValue(reduced ? 1 : 0)

  useEffect(() => {
    if (reduced) {
      rot.value = 0
      opacity.value = 1
      return
    }
    // Reset, then flip down into place after the staggered delay.
    rot.value = -90
    opacity.value = 0
    rot.value = withDelay(index * stagger, withSpring(0, motion.flapSpring))
    opacity.value = withDelay(
      index * stagger,
      withTiming(1, { duration: 160, easing: Easing.bezier(...motion.expoOut) }),
    )
  }, [char, index, stagger, reduced, rot, opacity])

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ perspective: 400 }, { rotateX: `${rot.value}deg` }],
  }))

  const cellW = size * 0.82
  const cellH = size * 1.18

  return (
    <Animated.View
      style={[
        styles.cell,
        animStyle,
        {
          width: cellW,
          height: cellH,
          borderRadius: Math.max(4, size * 0.14),
          backgroundColor: t.palette.void,
          borderColor: t.palette.hairline,
        },
      ]}
    >
      <Animated.Text
        style={{ fontFamily: fonts.monoBold, fontSize: size, lineHeight: cellH, color }}
        allowFontScaling={false}
      >
        {char === ' ' ? ' ' : char}
      </Animated.Text>
      {/* The split-flap seam across the middle. */}
      <View style={[styles.seam, { backgroundColor: t.palette.void, borderBottomColor: 'rgba(0,0,0,0.55)' }]} />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  seam: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
})
