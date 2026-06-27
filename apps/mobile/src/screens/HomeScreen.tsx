import { useEffect } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, FlapText, Text } from '@/ui'
import { WindowAtmosphere } from '@/components/WindowAtmosphere'
import { Bloom } from '@/components/Bloom'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

const H_PADDING = 24

/**
 * Home / Landing — the hero. Streaks drift, RAILREEL flips in letter-by-letter,
 * a warm bloom ignites behind "Host a session". See docs/design-language.md.
 */
export function HomeScreen({
  onHost,
  onJoin,
}: {
  onHost?: () => void
  onJoin?: () => void
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  const { width } = useWindowDimensions()

  // Fit "RAILREEL" (8 cells) to the available width; cap at the design size.
  const logoSize = Math.max(22, Math.min(40, Math.floor((width - H_PADDING * 2) / 8.4)))

  // The action group rises in after the wordmark has clattered into place.
  const rise = useSharedValue(reduced ? 1 : 0)
  useEffect(() => {
    if (reduced) {
      rise.value = 1
      return
    }
    rise.value = withDelay(
      750,
      withTiming(1, { duration: motion.slow, easing: Easing.bezier(...motion.expoOut) }),
    )
    return () => cancelAnimation(rise)
  }, [reduced, rise])

  const riseStyle = useAnimatedStyle(() => ({
    opacity: rise.value,
    transform: [{ translateY: (1 - rise.value) * 18 }],
  }))

  return (
    <View style={styles.fill}>
      <WindowAtmosphere intensity={1} />

      <View style={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 28 }]}>
        <Text variant="eyebrow" tone="secondary">
          OFFLINE · IN SYNC · TOGETHER
        </Text>

        <View style={styles.hero}>
          <FlapText value="RAILREEL" size={logoSize} tone="primary" stagger={55} />
          <Text variant="eyebrow" tone="secondary" style={styles.tagline}>
            THE THEATER THAT TRAVELS
          </Text>
        </View>

        <Animated.View style={[styles.actions, riseStyle]}>
          <View style={styles.hostWrap}>
            {/* Bloom is a preceding sibling, so it naturally paints behind the button. */}
            <Bloom size={320} color={t.palette.amberGlow} intensity={0.32} style={styles.bloom} />
            <Button
              title="Host a session"
              subtitle="Share your movie with the cabin"
              intent="amber"
              onPress={onHost}
            />
          </View>

          <Button title="Join a session" subtitle="Find friends nearby" intent="cyan" onPress={onJoin} />

          <View style={styles.footer}>
            <Text variant="eyebrow" tone="secondary">
              NO INTERNET NEEDED
            </Text>
            <View style={styles.dots}>
              <View style={[styles.dot, { backgroundColor: t.palette.hairline }]} />
              <View style={[styles.dot, { backgroundColor: t.palette.hairline }]} />
              <View style={[styles.dot, { backgroundColor: t.palette.amberCore }]} />
            </View>
          </View>
        </Animated.View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flex: 1, paddingHorizontal: H_PADDING, justifyContent: 'space-between' },
  hero: { flex: 1, justifyContent: 'center', gap: 18 },
  tagline: { marginLeft: 4 },
  actions: { gap: 14 },
  hostWrap: { position: 'relative' },
  bloom: { position: 'absolute', top: -128, left: -24 },
  footer: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
})
