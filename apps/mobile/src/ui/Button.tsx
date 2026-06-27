import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import * as Haptics from 'expo-haptics'
import { Text } from './Text'
import { Bloom } from '@/components/Bloom'
import { useTheme } from '@/theme/ThemeProvider'
import { motion } from '@/theme/tokens'

/**
 * Primary action control. `amber` = filled tungsten CTA (warm, human); `cyan` = ghost
 * outline (connection/secondary). Press = scale + a filament-glow bloom (rendered as an
 * SVG sibling so it isn't clipped, and works identically on iOS + Android) + a light
 * haptic. Respects reduce-motion. See docs/design-language.md.
 */

export type ButtonProps = {
  title: string
  subtitle?: string
  intent?: 'amber' | 'cyan'
  onPress?: () => void
  disabled?: boolean
  style?: ViewStyle
}

export function Button({
  title,
  subtitle,
  intent = 'amber',
  onPress,
  disabled = false,
  style,
}: ButtonProps) {
  const t = useTheme()
  const reduced = useReducedMotion()
  const pressed = useSharedValue(0)
  const isAmber = intent === 'amber'

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduced ? 1 : 1 - pressed.value * 0.04 }],
  }))
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + pressed.value * 0.45,
    transform: [{ scale: 1 + pressed.value * 0.06 }],
  }))

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
      <View style={[styles.frame, disabled && styles.disabled]}>
        {/* Filament glow — SVG sibling behind the card, never clipped. */}
        <Animated.View style={[styles.glow, glowStyle]} pointerEvents="none">
          <Bloom
            size={260}
            color={isAmber ? t.palette.amberGlow : t.palette.cyan}
            intensity={isAmber ? 0.45 : 0.22}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.card,
            cardStyle,
            { borderRadius: t.radii.lg },
            !isAmber && { borderWidth: 1, borderColor: t.palette.cyanDeep, backgroundColor: 'rgba(87,210,230,0.06)' },
          ]}
        >
          {isAmber ? (
            <LinearGradient
              colors={t.gradients.amberFill}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
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
        </Animated.View>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  frame: { alignItems: 'stretch', justifyContent: 'center' },
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    minHeight: 64,
    paddingHorizontal: 22,
    paddingVertical: 14,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  labels: { gap: 2 },
  subtitle: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
})
