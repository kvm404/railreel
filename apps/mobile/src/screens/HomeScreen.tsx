import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { RadioTower, Radar, MoonStar, WifiOff } from 'lucide-react-native'
import { Button, FlapText, Text } from '@/ui'
import { SyncDots } from '@/components/SyncDots'
import { StatusScreen } from '@/components/StatusScreen'
import { FilamentBloom } from '@/components/FilamentBloom'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useBackHandler, useNavigation } from '@/navigation/context'
import { useSession } from '@/session/SessionProvider'
import { useTheme } from '@/theme/ThemeProvider'
import { motion, sizes } from '@/theme/tokens'
import { describeCleanupFailure, formatBytes } from '@/lib/storage'

const H_PADDING = sizes.gutter

/**
 * Home / Landing — the hero. The night-window streaks drift, RAILREEL flips in
 * letter-by-letter, then the actions rise in. See docs/design-language.md.
 */
export function HomeScreen() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const reduced = useReduceMotion()
  const { width, height } = useWindowDimensions()
  const nav = useNavigation()
  const s = useSession()
  // Back on the end-of-session card dismisses it (same as its primary action) instead of
  // backgrounding the app with the card still up.
  useBackHandler(
    () => {
      s.dismissEnd()
      return true
    },
    { enabled: s.sessionEnd != null, layer: 'overlay' },
  )

  // Landscape / split-screen: hero beside the actions instead of stacked (nothing clipped).
  const sideBySide = width > height && height < sizes.compactHeight
  const contentWidth = (sideBySide ? width / 2 : width) - H_PADDING * 2 - (sideBySide ? 0 : insets.left + insets.right)
  // Fit "RAILREEL" (8 cells) to the available width; cap at the design size.
  const logoSize = Math.max(22, Math.min(40, Math.floor(contentWidth / 8.4)))

  // The end-of-session card's cache action: verify the bytes are actually gone before dismissing.
  const [purging, setPurging] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)
  useEffect(() => {
    if (!s.sessionEnd) setPurgeError(null)
  }, [s.sessionEnd])
  const purgeAndDismiss = async () => {
    if (purging) return
    setPurging(true)
    setPurgeError(null)
    let threw = false
    let remaining = 0
    try {
      await s.purgeCache()
    } catch {
      threw = true
    }
    try {
      remaining = (await s.getCacheInfo()).totalBytes
    } catch {
      threw = true
    }
    setPurging(false)
    const failure = describeCleanupFailure(remaining, threw)
    if (failure) setPurgeError(failure)
    else s.dismissEnd()
  }

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

  const hero = (
    <View style={[styles.hero, sideBySide && styles.heroSide]}>
      <FlapText value="RAILREEL" size={logoSize} tone="primary" stagger={55} />
      <Text variant="eyebrow" tone="secondary" style={styles.tagline}>
        THE THEATER THAT TRAVELS
      </Text>
    </View>
  )

  const actions = (
    <Animated.View
      style={[styles.actions, sideBySide && styles.actionsSide, riseStyle]}
      accessibilityElementsHidden={!introReady}
      importantForAccessibility={introReady ? 'auto' : 'no-hide-descendants'}
    >
      <View>
        {/* The restrained filament bloom the design language calls for behind the one primary CTA. */}
        <FilamentBloom lit={introReady} breathe peak={0.85} style={styles.ctaBloom} />
        <Button
          title="Host a session"
          subtitle="Share your movie with the cabin"
          intent="amber"
          height={74}
          icon={<RadioTower size={22} color={t.palette.onAmber} strokeWidth={2.25} />}
          onPress={() => nav.navigate('CreateSession')}
        />
      </View>

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
  )

  // While the end-of-session card is up, everything beneath it leaves the accessibility tree so
  // TalkBack can't wander onto controls the card is covering.
  const underneathHidden = s.sessionEnd != null

  return (
    <View style={styles.fill}>
      <View
        style={styles.fill}
        accessibilityElementsHidden={underneathHidden}
        importantForAccessibility={underneathHidden ? 'no-hide-descendants' : 'auto'}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            sideBySide && styles.contentSide,
            {
              paddingTop: insets.top + 24,
              paddingBottom: insets.bottom + (sideBySide ? 24 : 46),
              paddingLeft: H_PADDING + insets.left,
              paddingRight: H_PADDING + insets.right,
            },
          ]}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {sideBySide ? (
            <View style={styles.leftCol}>
              <Text variant="eyebrow" tone="secondary">
                OFFLINE · IN SYNC · TOGETHER
              </Text>
              {hero}
            </View>
          ) : (
            <>
              <Text variant="eyebrow" tone="secondary">
                OFFLINE · IN SYNC · TOGETHER
              </Text>
              {hero}
            </>
          )}
          {actions}
        </ScrollView>
      </View>

      {/* An abnormal end (host left / lost signal) lands here as a designed moment. */}
      {s.sessionEnd ? (
        <StatusScreen
          icon={
            s.sessionEnd.kind === 'lost' ? (
              <WifiOff size={44} color={t.palette.cyan} strokeWidth={1.75} />
            ) : (
              <MoonStar size={44} color={t.palette.amber} strokeWidth={1.75} />
            )
          }
          tone={s.sessionEnd.kind === 'lost' ? 'cyan' : 'amber'}
          eyebrow={s.sessionEnd.eyebrow}
          headline={s.sessionEnd.headline}
          body={s.sessionEnd.body}
          notice={purgeError}
          primary={{ label: 'Back to the platform', onPress: s.dismissEnd }}
          secondary={
            s.cacheStatus && s.cacheStatus.totalBytes > 0
              ? {
                  label: purging
                    ? 'Deleting…'
                    : purgeError
                      ? `Try again (${formatBytes(s.cacheStatus.totalBytes)})`
                      : `Delete Cache (${formatBytes(s.cacheStatus.totalBytes)})`,
                  intent: 'neutral',
                  onPress: purgeAndDismiss,
                }
              : undefined
          }
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // flexGrow (not flex: 1) so large text / short windows scroll instead of clipping.
  content: { flexGrow: 1, justifyContent: 'space-between' },
  contentSide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 32 },
  leftCol: { flex: 1, gap: 18 },
  hero: { flex: 1, justifyContent: 'center', gap: 18, minHeight: 120 },
  heroSide: { flex: 0 },
  tagline: { marginLeft: 4 },
  actions: { gap: 14 },
  actionsSide: { flex: 1, maxWidth: 360 },
  ctaBloom: { top: -34, bottom: -34, left: -26, right: -26 },
  footer: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
})
