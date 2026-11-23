import { memo, useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { RotateCcw } from 'lucide-react-native'
import { Button, Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { withAlpha } from '@/ui/alpha'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'

/**
 * What the film area says when there is no film to show.
 *
 * - `loading`: a quiet threading cue — a short tungsten filament breathing in the dark and one
 *   mono line. The Player debounces it, so the blip of a drift-seek never flashes it.
 * - `error`: a designed dead end with a way out — "The reel snagged", what that means here, and
 *   actions (back to the lobby; try loading the copy again). Never a bare black frame.
 */

export const PlayerStatusOverlay = memo(function PlayerStatusOverlay({
  state,
  firstLoad,
  isHost,
  detail,
  onRetry,
  onLeave,
}: {
  state: 'ok' | 'loading' | 'error'
  /** Nothing has played yet (vs. a mid-film rebuffer). */
  firstLoad: boolean
  isHost: boolean
  detail?: string | null
  onRetry: () => void
  onLeave: () => void
}) {
  const t = useTheme()
  if (state === 'error') {
    return (
      <Animated.View
        entering={FadeIn.duration(220)}
        style={[styles.fill, styles.center, { backgroundColor: withAlpha(t.palette.void, 0.92) }]}
        accessibilityViewIsModal
      >
        <View style={styles.errorCard} accessibilityRole="alert">
          <Text variant="eyebrow" style={{ color: t.palette.danger }}>
            PROJECTOR FAULT
          </Text>
          <Text variant="title" tone="primary" style={styles.centerText}>
            The reel snagged
          </Text>
          <Text variant="body" tone="secondary" style={styles.centerText}>
            {isHost
              ? "This phone couldn't keep playing the film. The room is paused — nobody runs ahead."
              : "Your copy of the film won't play right now. The others keep watching; you can step back to the lobby or try again."}
          </Text>
          {detail ? (
            <Text variant="data" tone="secondary" style={[styles.centerText, styles.detail]} numberOfLines={2}>
              {detail}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button title="Back to the lobby" height={52} onPress={onLeave} />
            <IconButton
              variant="ghost"
              size={44}
              radius={radii.pill}
              label="Try again"
              icon={(c) => <RotateCcw size={15} color={c} strokeWidth={2} />}
              accessibilityLabel="Try loading the film again"
              onPress={onRetry}
            />
          </View>
        </View>
      </Animated.View>
    )
  }
  if (state === 'loading') return <Threading firstLoad={firstLoad} />
  return null
})

function Threading({ firstLoad }: { firstLoad: boolean }) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const glow = useSharedValue(0.35)

  useEffect(() => {
    if (reduced) return
    glow.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true)
    return () => cancelAnimation(glow)
  }, [reduced, glow])

  const filament = useAnimatedStyle(() => ({ opacity: reduced ? 0.8 : glow.value }))

  return (
    <Animated.View
      entering={FadeIn.duration(240)}
      exiting={FadeOut.duration(160)}
      pointerEvents="none"
      style={[styles.fill, styles.center]}
      accessibilityLiveRegion="polite"
    >
      <Animated.View style={[styles.filament, { backgroundColor: t.palette.amber, shadowColor: t.palette.amberGlow }, filament]} />
      <Text variant="data" tone="secondary" style={[styles.loadingText, { textShadowColor: t.palette.void }]}>
        {firstLoad ? 'Threading the reel…' : 'Catching the reel…'}
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  centerText: { textAlign: 'center' },
  errorCard: { maxWidth: 420, width: '100%', alignItems: 'center', gap: 12 },
  detail: { fontSize: 11, opacity: 0.8 },
  actions: { alignSelf: 'stretch', gap: 12, alignItems: 'center', marginTop: 8 },
  filament: {
    width: 56,
    height: 2,
    borderRadius: 1,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 6,
    elevation: 3,
  },
  loadingText: { marginTop: 14, textShadowRadius: 6 },
})
