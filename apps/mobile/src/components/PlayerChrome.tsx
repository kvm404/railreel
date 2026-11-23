import { memo, type ReactNode } from 'react'
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from '@/ui'
import { withAlpha } from '@/ui/alpha'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * Player chrome as letterbox curtains: a top bar and a bottom bar of deep night that slide in
 * from the screen edges when the film is tapped and slide back out to leave it unobstructed
 * (docs/design-language.md: "Player controls ride inside letterbox bars"). One shared progress
 * value (0 = closed, 1 = open) drives both on the UI thread; under reduce-motion they don't
 * travel — the same value just switches their opacity.
 *
 * Closed curtains are untouchable and hidden from TalkBack, so taps fall through to the film.
 */

export function Curtain({
  edge,
  progress,
  open,
  onHeight,
  style,
  children,
}: {
  edge: 'top' | 'bottom'
  progress: SharedValue<number>
  /** React-side open state (pointer events + accessibility). */
  open: boolean
  onHeight?: (h: number) => void
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const height = useSharedValue(0)

  const anim = useAnimatedStyle(() => {
    const p = progress.value
    if (reduced) return { opacity: p, transform: [] }
    const off = (1 - p) * (height.value + 12)
    return { opacity: Math.min(1, p * 1.5), transform: [{ translateY: edge === 'top' ? -off : off }] }
  })

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height
    height.value = h
    onHeight?.(h)
  }

  const shade = withAlpha(t.palette.void, 0.94)
  const mid = withAlpha(t.palette.void, 0.7)
  const clear = withAlpha(t.palette.void, 0)

  return (
    <Animated.View
      onLayout={onLayout}
      pointerEvents={open ? 'box-none' : 'none'}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      style={[styles.curtain, edge === 'top' ? styles.top : styles.bottom, anim, style]}
    >
      <LinearGradient
        pointerEvents="none"
        colors={edge === 'top' ? [shade, mid, clear] : [clear, mid, shade]}
        locations={edge === 'top' ? [0, 0.6, 1] : [0, 0.35, 1]}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </Animated.View>
  )
}

export type SyncTone = 'cyan' | 'amber' | 'danger' | 'quiet'

/** The status chip in the top curtain: a dot (cyan only for real sync state) and a mono label. */
export const SyncTag = memo(function SyncTag({ label, tone }: { label: string; tone: SyncTone }) {
  const t = useTheme()
  const dot =
    tone === 'cyan' ? t.palette.cyan : tone === 'amber' ? t.palette.amber : tone === 'danger' ? t.palette.danger : t.palette.textSecondary
  return (
    <View
      style={styles.tag}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label.toLowerCase().replace('…', '')}`}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.dot, { backgroundColor: dot, shadowColor: dot }]} />
      <Text variant="eyebrow" tone="secondary" numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  curtain: { position: 'absolute', left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
})
