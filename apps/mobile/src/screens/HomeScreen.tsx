import { useEffect, useState } from 'react'
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
import { RadioTower, Radar } from 'lucide-react-native'
import { Button, FlapText, Text } from '@/ui'
import { SyncDots } from '@/components/SyncDots'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

const H_PADDING = 24

/**
 * Home / Landing — the hero. The night-window streaks drift, RAILREEL flips in
 * letter-by-letter, then the actions rise in. See docs/design-language.md.
 */
export function HomeScreen() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  const { width } = useWindowDimensions()
  const nav = useNavigation()

  // Fit "RAILREEL" (8 cells) to the available width; cap at the design size.
  const logoSize = Math.max(22, Math.min(40, Math.floor((width - H_PADDING * 2) / 8.4)))

  // The action group rises in after the wordmark has clattered into place.
  const rise = useSharedValue(reduced ? 1 : 0)
  const [introReady, setIntroReady] = useState(reduced)
  useEffect(() => {
    if (reduced) {
      rise.value = 1
      setIntroReady(true)
      return
    }
    rise.value = withDelay(
      750,
      withTiming(1, { duration: motion.slow, easing: Easing.bezier(...motion.expoOut) }),
    )
    // Keep the still-invisible actions out of the a11y tree until they've arrived.
    const id = setTimeout(() => setIntroReady(true), 750 + motion.slow)
    return () => {
      clearTimeout(id)
      cancelAnimation(rise)
    }
  }, [reduced, rise])

  const riseStyle = useAnimatedStyle(() => ({
    opacity: rise.value,
    transform: [{ translateY: (1 - rise.value) * 18 }],
  }))

  return (
    <View style={styles.fill}>
      <View style={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 46 }]}>
        <Text variant="eyebrow" tone="secondary">
          OFFLINE · IN SYNC · TOGETHER
        </Text>

        <View style={styles.hero}>
          <FlapText value="RAILREEL" size={logoSize} tone="primary" stagger={55} />
          <Text variant="eyebrow" tone="secondary" style={styles.tagline}>
            THE THEATER THAT TRAVELS
          </Text>
        </View>

        <Animated.View
          style={[styles.actions, riseStyle]}
          accessibilityElementsHidden={!introReady}
          importantForAccessibility={introReady ? 'auto' : 'no-hide-descendants'}
        >
          <Button
            title="Host a session"
            subtitle="Share your movie with the cabin"
            intent="amber"
            height={74}
            icon={<RadioTower size={22} color={t.palette.onAmber} strokeWidth={2.25} />}
            onPress={() => nav.navigate('CreateSession')}
          />

          <Button
            title="Join a session"
            subtitle="Find friends nearby"
            intent="cyan"
            height={66}
            icon={<Radar size={22} color={t.palette.cyan} strokeWidth={2.25} />}
            onPress={() => nav.navigate('JoinSession')}
          />

          <View style={styles.footer}>
            <Text variant="eyebrow" tone="secondary">
              NO INTERNET NEEDED
            </Text>
            <SyncDots />
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
  footer: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
})
