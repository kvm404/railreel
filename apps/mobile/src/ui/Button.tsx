import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import * as Haptics from 'expo-haptics'
import { Text } from './Text'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { ghostSkins } from '@/theme/buttonSkins'
import { motion, radii, sizes } from '@/theme/tokens'

/**
 * Primary action control. Hierarchy comes from weight and material, not light:
 *  - `amber`   filled tungsten CTA (warm, human, the one primary action)
 *  - `neutral` cool-steel ghost — the default SECONDARY (leave, deny, remove, keep, attach…)
 *  - `danger`  outlined warning — destructive/irreversible actions
 *  - `cyan`    ghost reserved for CONNECTION: join, scan, sync, retry-the-network
 * Press = a small scale + downward "depress" + a tint veil + light haptic. Disabled, pressed and
 * keyboard/TalkBack-focused states are the same across intents. Respects reduce-motion.
 * See docs/design-language.md.
 */

export type ButtonIntent = 'amber' | 'cyan' | 'neutral' | 'danger'

export type ButtonProps = {
  title: string
  subtitle?: string
  intent?: ButtonIntent
  icon?: ReactNode
  height?: number
  /** Inline/secondary size: a short pill with caption type (still a 44dp touch target via hitSlop). */
  compact?: boolean
  onPress?: () => void
  disabled?: boolean
  style?: ViewStyle
}

export function Button({
  title,
  subtitle,
  intent = 'amber',
  icon,
  height,
  compact = false,
  onPress,
  disabled = false,
  style,
}: ButtonProps) {
  const t = useTheme()
  const reduced = useReduceMotion()
  const pressed = useSharedValue(0)
  const [focused, setFocused] = useState(false)
  const isAmber = intent === 'amber'
  const h = height ?? (compact ? sizes.buttonCompact : 66)
  const radius = compact ? radii.md : Math.min(radii.xl, h / 2)

  const g = isAmber ? null : ghostSkins[intent]
  const skin = g && { border: t.veils[g.border], bg: t.veils[g.bg], pressed: t.veils[g.pressed], title: g.title, subtitle: g.subtitle }

  const cardStyle = useAnimatedStyle(() => ({
    transform: reduced
      ? []
      : [{ scale: 1 - pressed.value * 0.02 }, { translateY: pressed.value * 2 }],
  }))
  // The tint veil that deepens on press (also the only press cue under reduce-motion).
  const veilStyle = useAnimatedStyle(() => ({ opacity: pressed.value }))

  // If the button is disabled mid-press, Pressable may never fire onPressOut —
  // release the depressed state so it doesn't stick.
  useEffect(() => {
    if (disabled) {
      cancelAnimation(pressed)
      pressed.value = 0
    }
  }, [disabled, pressed])

  const onIn = () => {
    pressed.value = withTiming(1, { duration: motion.fast })
  }
  const onOut = () => {
    pressed.value = withSpring(0, motion.spring)
  }
  const handlePress = () => {
    if (disabled) return
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onPress?.()
  }

  return (
    <Pressable
      onPressIn={onIn}
      onPressOut={onOut}
      onPress={handlePress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      disabled={disabled}
      hitSlop={compact ? { top: 6, bottom: 6, left: 4, right: 4 } : undefined}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ disabled }}
      style={style}
    >
      <Animated.View
        style={[
          styles.card,
          compact && styles.cardCompact,
          cardStyle,
          { minHeight: h, borderRadius: radius },
          isAmber
            ? { borderBottomWidth: 2, borderBottomColor: t.veils.buttonEdge }
            : { borderWidth: 1, borderColor: skin!.border, backgroundColor: skin!.bg },
          focused && { borderColor: t.palette.textPrimary, borderWidth: 2 },
          disabled && styles.disabled,
        ]}
      >
        {isAmber ? (
          <LinearGradient
            colors={t.gradients.amberFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
          />
        ) : null}
        {/* press veil: warm-dark on amber, the intent tint on ghosts */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: isAmber ? t.veils.buttonEdge : skin!.pressed }, veilStyle]}
        />
        <View style={styles.row}>
          {icon ? <View style={styles.icon}>{icon}</View> : null}
          <View style={styles.labels}>
            <Text variant={compact ? 'caption' : 'cardTitle'} tone={isAmber ? 'onAmber' : skin!.title}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="caption" tone={isAmber ? 'onAmber' : skin!.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cardCompact: { paddingHorizontal: 14, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  icon: { width: 24, alignItems: 'center', justifyContent: 'center' },
  labels: { gap: 2, flexShrink: 1 },
  disabled: { opacity: 0.4 },
})
