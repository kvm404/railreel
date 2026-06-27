import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native'
import Animated, {
  useAnimatedStyle,
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
 * Primary action control. `amber` = filled tungsten CTA (the warm, human choice);
 * `cyan` = ghost outline (connection/secondary). Press = scale + filament-glow bloom
 * + a light haptic. See docs/design-language.md.
 */

export type ButtonProps = {
  title: string
  subtitle?: string
  intent?: 'amber' | 'cyan'
  onPress?: () => void
  disabled?: boolean
  style?: ViewStyle
}

const AnimatedGradient = Animated.createAnimatedComponent(LinearGradient)

export function Button({
  title,
  subtitle,
  intent = 'amber',
  onPress,
  disabled = false,
  style,
}: ButtonProps) {
  const t = useTheme()
  const pressed = useSharedValue(0)
  const isAmber = intent === 'amber'

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.04 }],
    shadowRadius: 12 + pressed.value * 14,
    shadowOpacity: (isAmber ? 0.5 : 0.0) + pressed.value * 0.35,
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
    >
      <Animated.View
        style={[
          styles.container,
          { borderRadius: t.radii.lg, shadowColor: isAmber ? t.palette.amberCore : t.palette.cyan },
          containerStyle,
          disabled && styles.disabled,
          style,
        ]}
      >
        {isAmber ? (
          <AnimatedGradient
            colors={t.gradients.amberFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <View
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: t.radii.lg, borderWidth: 1, borderColor: t.palette.cyanDeep, backgroundColor: 'rgba(87,210,230,0.06)' },
            ]}
          />
        )}
        <View style={styles.labels}>
          <Text variant="cardTitle" tone={isAmber ? 'onAmber' : 'cyan'}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone={isAmber ? 'onAmber' : 'secondary'} style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    minHeight: 64,
    paddingHorizontal: 22,
    paddingVertical: 14,
    justifyContent: 'center',
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 6 },
  },
  labels: { gap: 2 },
  subtitle: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
})
