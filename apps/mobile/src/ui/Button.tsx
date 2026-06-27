import { useEffect, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import * as Haptics from 'expo-haptics'
import { Text } from './Text'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

/**
 * Primary action control. `amber` = filled tungsten CTA (warm, human, primary);
 * `cyan` = ghost outline (connection/secondary, recedes). Hierarchy comes from weight
 * and material, not light. Press = a small scale + downward "depress" + light haptic.
 * Respects reduce-motion. See docs/design-language.md.
 */

export type ButtonProps = {
  title: string
  subtitle?: string
  intent?: 'amber' | 'cyan'
  icon?: ReactNode
  height?: number
  onPress?: () => void
  disabled?: boolean
  style?: ViewStyle
}

const RADIUS = 24

export function Button({
  title,
  subtitle,
  intent = 'amber',
  icon,
  height = 66,
  onPress,
  disabled = false,
  style,
}: ButtonProps) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const pressed = useSharedValue(0)
  const isAmber = intent === 'amber'

  const cardStyle = useAnimatedStyle(() => ({
    transform: reduced
      ? []
      : [{ scale: 1 - pressed.value * 0.02 }, { translateY: pressed.value * 2 }],
  }))

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
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ disabled }}
      style={style}
    >
      <Animated.View
        style={[
          styles.card,
          cardStyle,
          { minHeight: height, borderRadius: RADIUS },
          isAmber
            ? { borderBottomWidth: 2, borderBottomColor: 'rgba(0,0,0,0.22)' }
            : { borderWidth: 1, borderColor: 'rgba(87,210,230,0.35)', backgroundColor: 'rgba(87,210,230,0.05)' },
          disabled && styles.disabled,
        ]}
      >
        {isAmber ? (
          <LinearGradient
            colors={t.gradients.amberFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[StyleSheet.absoluteFill, { borderRadius: RADIUS }]}
          />
        ) : null}
        <View style={styles.row}>
          {icon ? <View style={styles.icon}>{icon}</View> : null}
          <View style={styles.labels}>
            <Text variant="cardTitle" tone={isAmber ? 'onAmber' : 'cyan'}>
              {title}
            </Text>
            {subtitle ? (
              <Text
                variant="caption"
                tone={isAmber ? 'onAmber' : 'secondary'}
                style={styles.subtitle}
              >
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  icon: { width: 24, alignItems: 'center', justifyContent: 'center' },
  labels: { gap: 2, flexShrink: 1 },
  subtitle: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
})
