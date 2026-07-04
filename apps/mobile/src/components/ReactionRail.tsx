import { useCallback, useEffect, useRef } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { MessageCircle } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * The micro rail: five reactions + chat, one tap away for the whole show — even with the player
 * controls hidden. A translucent pill that dims to a whisper when idle and wakes on touch, so it
 * never competes with the film. See docs/design-language.md (warm = human = interactive).
 */

export const RAIL_EMOJI = ['❤️', '🤣', '😱', '🍿', '😢'] as const

const IDLE_DIM_MS = 4000
const DIM_OPACITY = 0.4

export function ReactionRail({
  onReact,
  onOpenChat,
  unread,
  bottom,
}: {
  onReact: (emoji: string) => void
  onOpenChat: () => void
  unread: number
  bottom: number
}) {
  const t = useTheme()
  const opacity = useSharedValue(1)
  const dimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const wake = useCallback(() => {
    opacity.value = withTiming(1, { duration: 120 })
    if (dimTimer.current) clearTimeout(dimTimer.current)
    dimTimer.current = setTimeout(() => {
      opacity.value = withTiming(DIM_OPACITY, { duration: 600 })
    }, IDLE_DIM_MS)
  }, [opacity])

  useEffect(() => {
    wake()
    return () => {
      if (dimTimer.current) clearTimeout(dimTimer.current)
    }
  }, [wake])

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))

  const react = (emoji: string) => {
    wake()
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    onReact(emoji)
  }

  return (
    <Animated.View style={[styles.rail, { bottom, borderColor: t.palette.hairline, backgroundColor: 'rgba(18,24,38,0.78)' }, style]}>
      {RAIL_EMOJI.map((e) => (
        <Pressable key={e} onPress={() => react(e)} hitSlop={8} style={({ pressed }) => [styles.key, pressed && styles.pressed]}>
          <Text style={styles.emoji}>{e}</Text>
        </Pressable>
      ))}
      <View style={[styles.divider, { backgroundColor: t.palette.hairline }]} />
      <Pressable
        onPress={() => {
          wake()
          onOpenChat()
        }}
        hitSlop={8}
        style={({ pressed }) => [styles.key, pressed && styles.pressed]}
        accessibilityLabel="Open chat"
      >
        <MessageCircle size={20} color={t.palette.textSecondary} strokeWidth={2} />
        {unread > 0 ? (
          <View style={[styles.badge, { backgroundColor: t.palette.amber }]}>
            <Text style={styles.badgeText}>{unread > 9 ? '9+' : String(unread)}</Text>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 46,
    borderRadius: 999,
    borderWidth: 1,
  },
  key: { paddingHorizontal: 7, height: 40, alignItems: 'center', justifyContent: 'center' },
  pressed: { transform: [{ scale: 1.25 }] },
  emoji: { fontSize: 21, lineHeight: 26 },
  divider: { width: 1, height: 20, marginHorizontal: 4 },
  badge: {
    position: 'absolute',
    top: 2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 10, lineHeight: 12, color: '#1A1206', fontWeight: '700' },
})
