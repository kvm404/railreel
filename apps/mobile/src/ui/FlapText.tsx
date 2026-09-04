import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View, type ViewStyle } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'
import { useTheme } from '@/theme/ThemeProvider'
import { fonts } from '@/theme/tokens'

/**
 * The split-flap departure board — RailReel's signature element.
 *
 * A real two-half flip: the upper flap of the OLD glyph rotates away to reveal the
 * NEW glyph's top, then the NEW glyph's lower flap falls into place — like a Solari
 * board. Re-animates whenever `value` changes (and cascades left→right on mount).
 * See docs/design-language.md.
 */

export type FlapTextProps = {
  value: string
  /** Glyph height; cell sizing derives from this. */
  size?: number
  tone?: 'primary' | 'amber' | 'cyan'
  /** Stagger between cells on entrance (ms). 0 flips all at once. */
  stagger?: number
  /** Buzz a selection haptic as the board lands. */
  haptics?: boolean
  style?: ViewStyle
}

const TONE = {
  primary: 'textPrimary',
  amber: 'amber',
  cyan: 'cyan',
} as const

export function FlapText({
  value,
  size = 28,
  tone = 'primary',
  stagger = 40,
  haptics = true,
  style,
}: FlapTextProps) {
  const t = useTheme()
  const chars = value.split('')
  return (
    <View
      style={[styles.row, { gap: Math.max(2, size * 0.1) }, style]}
      accessibilityLabel={value}
      accessible
    >
      {chars.map((ch, i) => (
        <FlapCell
          // Keyed by POSITION so a cell persists and animates across value changes.
          key={i}
          char={ch}
          delay={i * stagger}
          size={size}
          color={t.palette[TONE[tone]]}
          haptic={haptics && i === chars.length - 1}
        />
      ))}
    </View>
  )
}

function FlapCell({
  char,
  delay,
  size,
  color,
  haptic,
}: {
  char: string
  delay: number
  size: number
  color: string
  haptic: boolean
}) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const progress = useSharedValue(1) // 1 = settled
  const [prev, setPrev] = useState(' ')
  const [curr, setCurr] = useState(char)
  const [flipping, setFlipping] = useState(false)
  const mounted = useRef(false)

  useEffect(() => {
    if (curr === char) return
    setPrev(curr)
    setCurr(char)

    if (reduced) {
      progress.value = 1
      return
    }
    setFlipping(true)
    progress.value = 0
    const startDelay = mounted.current ? 0 : delay
    progress.value = withDelay(
      startDelay,
      withTiming(1, { duration: 360, easing: Easing.bezier(0.16, 1, 0.3, 1) }, (done) => {
        if (done) {
          runOnJS(setFlipping)(false)
          if (haptic) runOnJS(Haptics.selectionAsync)()
        }
      }),
    )
    return () => cancelAnimation(progress)
    // `curr` intentionally excluded — comparison handled inside.
  }, [char, reduced, delay, haptic, progress])

  // Run the entrance flip on mount (blank -> first char).
  useEffect(() => {
    mounted.current = false
    if (reduced) {
      setFlipping(false)
      progress.value = 1
      return
    }
    setPrev(' ')
    setFlipping(true)
    progress.value = 0
    progress.value = withDelay(
      delay,
      withTiming(1, { duration: 360, easing: Easing.bezier(0.16, 1, 0.3, 1) }, (done) => {
        if (done) {
          runOnJS(setFlipping)(false)
          if (haptic) runOnJS(Haptics.selectionAsync)()
        }
      }),
    )
    const id = setTimeout(() => (mounted.current = true), delay + 360)
    return () => {
      clearTimeout(id)
      cancelAnimation(progress)
    }
  }, [])

  const flipTopStyle = useAnimatedStyle(() => ({
    opacity: progress.value < 0.5 ? 1 : 0,
    transform: [{ perspective: 600 }, { rotateX: `${interpolate(progress.value, [0, 0.5], [0, -90], 'clamp')}deg` }],
  }))
  const flipBottomStyle = useAnimatedStyle(() => ({
    opacity: progress.value >= 0.5 ? 1 : 0,
    transform: [{ perspective: 600 }, { rotateX: `${interpolate(progress.value, [0.5, 1], [90, 0], 'clamp')}deg` }],
  }))

  const cellW = size * 0.84
  const cellH = size * 1.26
  const cell = {
    width: cellW,
    height: cellH,
    borderRadius: Math.max(4, size * 0.14),
  }

  return (
    <View
      style={[
        styles.cell,
        cell,
        {
          backgroundColor: '#0C111B', // top-half base (cooler/lighter)
          borderColor: t.palette.hairline,
          borderTopColor: 'rgba(255,255,255,0.07)', // top bevel highlight
          borderBottomColor: 'rgba(0,0,0,0.55)', // bottom bevel shadow
        },
      ]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {/* Bottom half sits in darker material — gives each tile physical depth. */}
      <View style={[styles.bottomShade, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />

      {/* Resting state: the upper shows the target, the lower shows old until the flap falls. */}
      <Half which="top" char={curr} size={size} cellW={cellW} cellH={cellH} color={color} />
      <Half which="bottom" char={flipping ? prev : curr} size={size} cellW={cellW} cellH={cellH} color={color} />

      {flipping ? (
        <>
          <Animated.View style={[styles.half, styles.top, flipTopStyle, { transformOrigin: 'bottom' }]}>
            <Glyph which="top" char={prev} size={size} cellW={cellW} cellH={cellH} color={color} />
          </Animated.View>
          <Animated.View style={[styles.half, styles.bottom, flipBottomStyle, { transformOrigin: 'top' }]}>
            <Glyph which="bottom" char={curr} size={size} cellW={cellW} cellH={cellH} color={color} />
          </Animated.View>
        </>
      ) : null}

      {/* The split-flap hinge: a dark seam with a thin highlight beneath. */}
      <View style={[styles.hinge, { backgroundColor: 'rgba(0,0,0,0.7)' }]} />
      <View style={[styles.hingeHighlight, { backgroundColor: 'rgba(255,255,255,0.05)' }]} />
    </View>
  )
}

/** A static clipped half of the cell. */
function Half(props: { which: 'top' | 'bottom'; char: string; size: number; cellW: number; cellH: number; color: string }) {
  return (
    <View style={[styles.half, props.which === 'top' ? styles.top : styles.bottom]}>
      <Glyph {...props} />
    </View>
  )
}

/** The glyph rendered so a single half is visible within the clipped container. */
function Glyph({
  which,
  char,
  size,
  cellW,
  cellH,
  color,
}: {
  which: 'top' | 'bottom'
  char: string
  size: number
  cellW: number
  cellH: number
  color: string
}) {
  return (
    <View style={{ width: cellW, height: cellH, overflow: 'hidden' }}>
      <Animated.Text
        style={{
          fontFamily: fonts.monoBold,
          fontSize: size,
          lineHeight: cellH,
          width: cellW,
          textAlign: 'center',
          textAlignVertical: 'center',
          includeFontPadding: false, // Android: keep both halves aligned to the hinge
          color,
          marginTop: which === 'bottom' ? -cellH / 2 : 0,
        }}
        allowFontScaling={false}
      >
        {char}
      </Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  cell: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  half: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '50%',
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
  bottomShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '50%' },
  hinge: { position: 'absolute', left: 0, right: 0, top: '50%', height: 1, marginTop: -0.5 },
  hingeHighlight: { position: 'absolute', left: 0, right: 0, top: '50%', height: 1, marginTop: 0.5 },
})
