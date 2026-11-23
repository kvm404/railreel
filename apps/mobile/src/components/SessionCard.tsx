import { useEffect } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, {
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'
import { Text, FlapText } from '@/ui'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

/**
 * A discovered session, shown as a departure-board row crossed with a ticket stub:
 * host avatar, movie title + mono metadata, a split-flap status, and a film-sprocket
 * edge. See docs/design-language.md.
 */
export function SessionCard({
  host,
  title,
  meta,
  status,
  disabled = false,
  onPress,
}: {
  host: string
  title: string
  meta: string
  status: string
  disabled?: boolean
  onPress?: () => void
}) {
  const t = useTheme()
  const reduced = useReduceMotion()
  const pressed = useSharedValue(0)

  // The tint is the press cue that survives reduce-motion (the scale is dropped there).
  const raised = t.palette.raised
  const pressedFill = t.palette.overlay
  const animStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(pressed.value, [0, 1], [raised, pressedFill]),
    transform: reduced ? [] : [{ scale: 1 - pressed.value * 0.02 }],
  }))

  // Don't let the press state stick if the card is disabled mid-press.
  useEffect(() => {
    if (disabled) {
      cancelAnimation(pressed)
      pressed.value = 0
    }
  }, [disabled, pressed])

  return (
    <Pressable
      onPressIn={() => (pressed.value = withTiming(1, { duration: motion.fast }))}
      onPressOut={() => (pressed.value = withSpring(0, motion.spring))}
      onPress={() => {
        if (disabled) return
        Haptics.selectionAsync()
        onPress?.()
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={`${host}. ${title}. ${status}`}
    >
      <Animated.View
        style={[
          styles.card,
          { borderColor: t.palette.hairline, borderRadius: t.radii.lg },
          animStyle,
          disabled && { opacity: 0.5 },
        ]}
      >
        {/* film-sprocket edge */}
        <View style={styles.sprocket}>
          {Array.from({ length: 5 }).map((_, i) => (
            <View key={i} style={[styles.hole, { backgroundColor: t.palette.void }]} />
          ))}
        </View>

        <View style={[styles.avatar, { borderColor: t.palette.amberCore }]}>
          <Text variant="cardTitle" tone="amber">
            {host.charAt(0).toUpperCase()}
          </Text>
        </View>

        <View style={styles.info}>
          <Text variant="cardTitle" numberOfLines={1}>
            {host}
          </Text>
          <Text variant="data" tone="muted" numberOfLines={1}>
            {title} · {meta}
          </Text>
        </View>

        <FlapText value={status} size={13} tone={status === 'FULL' ? 'primary' : 'cyan'} stagger={0} haptics={false} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingLeft: 22,
    paddingRight: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sprocket: {
    position: 'absolute',
    left: 6,
    top: 0,
    bottom: 0,
    justifyContent: 'space-evenly',
  },
  hole: { width: 4, height: 4, borderRadius: 2 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, gap: 3 },
})
