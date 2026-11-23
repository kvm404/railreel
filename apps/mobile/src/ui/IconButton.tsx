import { useEffect, useState, type ReactNode, type Ref } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'
import { Text } from './Text'
import { withAlpha } from './alpha'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { motion, radii } from '@/theme/tokens'

/**
 * Compact control primitive for chrome that sits over the film: round icon buttons (back,
 * subtitles, transport, reactions) and small icon+label pills (moderation, requests, cleanup).
 *
 * One place for the interaction contract every one of those needs: a button role + label,
 * disabled/selected state announced to TalkBack, a touch target of at least `minTouch` that is
 * PHYSICAL (the pressable box itself, with the visual centred in it — hitSlop can't reach past a
 * parent's bounds, so it can't promise a target size; callers that sit side by side pass
 * `minTouch={size}`), a pressed state (small spring scale + light wash; wash only under
 * reduce-motion), an amber focus ring for keyboard / D-pad focus and an optional haptic accent.
 * Selected uses amber — the interactive/human hue; cyan stays reserved for sync.
 * See docs/design-language.md.
 */

export type IconButtonVariant = 'glass' | 'amber' | 'ghost' | 'plain'

export type IconButtonProps = {
  /** The glyph, or a render function given the state-appropriate foreground colour. */
  icon: ReactNode | ((color: string) => ReactNode)
  accessibilityLabel: string
  accessibilityHint?: string
  onPress?: () => void
  /** Optional text: turns the round button into a compact pill. */
  label?: string
  /** Visual height (and diameter when round). */
  size?: number
  /** Minimum touch target (the pressable's own box; the visual is centred in it). */
  minTouch?: number
  variant?: IconButtonVariant
  selected?: boolean
  disabled?: boolean
  /** Haptic accent on press. Pass 'none' when the caller confirms the action itself. */
  haptic?: 'light' | 'selection' | 'none'
  /** Small count/marker in the top-right corner (e.g. unread chat). */
  badge?: string | null
  /** Pill corner radius (round buttons are always circular). */
  radius?: number
  style?: StyleProp<ViewStyle>
  ref?: Ref<View>
}

const PRESS_SCALE = 0.92
/** Focus ring: 2dp amber, this far outside the visual. */
const FOCUS_GAP = 3

export function IconButton({
  icon,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  label,
  size = 44,
  minTouch = 48,
  variant = 'glass',
  selected = false,
  disabled = false,
  haptic = 'light',
  badge,
  radius,
  style,
  ref,
}: IconButtonProps) {
  const t = useTheme()
  const reduced = useReduceMotion()
  const pressed = useSharedValue(0)
  const [focused, setFocused] = useState(false)

  // Disabled mid-press: Pressable may never deliver onPressOut, so release the state here.
  useEffect(() => {
    if (disabled) {
      cancelAnimation(pressed)
      pressed.value = 0
    }
  }, [disabled, pressed])

  const bodyStyle = useAnimatedStyle(() => ({
    transform: reduced ? [] : [{ scale: 1 - pressed.value * (1 - PRESS_SCALE) }],
  }))
  const washStyle = useAnimatedStyle(() => ({ opacity: pressed.value }))

  const isAmber = variant === 'amber'
  const fg = disabled
    ? t.palette.textTertiary
    : isAmber
      ? t.palette.onAmber
      : selected
        ? t.palette.amber
        : t.palette.textPrimary
  const surface: ViewStyle =
    variant === 'amber'
      ? { backgroundColor: t.palette.amber, borderColor: t.palette.amberGlow, borderWidth: 1 }
      : variant === 'plain'
        ? {}
        : selected
          ? { backgroundColor: withAlpha(t.palette.amber, 0.16), borderColor: t.palette.amber, borderWidth: 1 }
          : variant === 'glass'
            ? { backgroundColor: withAlpha(t.palette.raised, 0.78), borderColor: t.palette.hairline, borderWidth: 1 }
            : { borderColor: t.palette.hairline, borderWidth: 1 }
  const wash = isAmber ? withAlpha(t.palette.amberGlow, 0.45) : withAlpha(t.palette.textPrimary, 0.12)
  const shape: ViewStyle = label
    ? { height: size, borderRadius: radius ?? radii.pill, paddingHorizontal: Math.round(size * 0.36) }
    : { width: size, height: size, borderRadius: size / 2 }
  const ringRadius = (shape.borderRadius as number) + FOCUS_GAP

  const handlePress = () => {
    if (disabled) return
    if (haptic === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    else if (haptic === 'selection') Haptics.selectionAsync().catch(() => {})
    onPress?.()
  }

  return (
    <Pressable
      ref={ref}
      onPress={handlePress}
      onPressIn={() => {
        pressed.value = withTiming(1, { duration: motion.fast / 2 })
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, motion.spring)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      style={[styles.target, { minWidth: minTouch, minHeight: minTouch }, style]}
    >
      {/* The visual (and its badge / focus ring) sits centred in the larger touch box. */}
      <View>
        {focused ? (
          <View
            pointerEvents="none"
            style={[styles.ring, { borderRadius: ringRadius, borderColor: t.palette.amber }]}
          />
        ) : null}
        <Animated.View style={[styles.body, shape, surface, disabled && styles.disabled, bodyStyle]}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: shape.borderRadius, backgroundColor: wash }, washStyle]} />
          {typeof icon === 'function' ? icon(fg) : icon}
          {label ? (
            <Text variant="caption" style={[styles.label, { color: fg }]} numberOfLines={1}>
              {label}
            </Text>
          ) : null}
        </Animated.View>
        {badge ? (
          <View pointerEvents="none" style={[styles.badge, { backgroundColor: t.palette.amber, borderColor: t.palette.void }]}>
            <Text style={[styles.badgeText, { color: t.palette.onAmber, fontFamily: t.fonts.monoBold }]}>{badge}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  target: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: -FOCUS_GAP, left: -FOCUS_GAP, right: -FOCUS_GAP, bottom: -FOCUS_GAP, borderWidth: 2 },
  body: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, overflow: 'hidden' },
  label: {},
  disabled: { opacity: 0.45 },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 10, lineHeight: 12 },
})
