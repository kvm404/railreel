import { memo, useCallback, useEffect, useRef, type Ref } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { MessageCircle } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { withAlpha } from '@/ui/alpha'
import { useTheme } from '@/theme/ThemeProvider'
import { RAIL_KEY_MIN } from '@/lib/player/layout'
import { RAIL_BACKING_ALPHA, RAIL_IDLE_MS, RAIL_IDLE_OPACITY } from '@/lib/player/rail'

/**
 * The micro rail: five reactions + chat, riding in the bottom curtain. A dark pill whose glyphs
 * soften when idle and wake on touch, so it never competes with the film — but only the glyphs
 * dim: the backing stays strong and the unread badge stays lit, so the controls keep ≥ 4.5:1 even
 * over a white frame (lib/player/rail). See docs/design-language.md (warm = human = interactive).
 *
 * Every key is a real `keySize` × `keySize` target (≥44dp, laid edge to edge with no hitSlop, so
 * neighbouring targets never overlap); the Player sizes it to fit the screen. The haptic accent
 * fires only when the store actually ACCEPTS the reaction (`onReact` returns true) — a tap
 * swallowed by the send rate-limit stays silent instead of buzzing for nothing.
 */

export const RAIL_EMOJI = ['❤️', '🤣', '😱', '🍿', '😢'] as const
const EMOJI_NAMES: Record<(typeof RAIL_EMOJI)[number], string> = {
  '❤️': 'heart',
  '🤣': 'laughing',
  '😱': 'screaming',
  '🍿': 'popcorn',
  '😢': 'crying',
}


export const ReactionRail = memo(function ReactionRail({
  onReact,
  onOpenChat,
  unread,
  keySize = RAIL_KEY_MIN,
  chatButtonRef,
}: {
  /** Returns whether the reaction was accepted (sent). */
  onReact: (emoji: string) => boolean
  onOpenChat: () => void
  unread: number
  keySize?: number
  /** Focus target when the chat sheet closes. */
  chatButtonRef?: Ref<View>
}) {
  const t = useTheme()
  const opacity = useSharedValue(1)
  const dimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const wake = useCallback(() => {
    opacity.value = withTiming(1, { duration: 120 })
    if (dimTimer.current) clearTimeout(dimTimer.current)
    dimTimer.current = setTimeout(() => {
      opacity.value = withTiming(RAIL_IDLE_OPACITY, { duration: 600 })
    }, RAIL_IDLE_MS)
  }, [opacity])

  useEffect(() => {
    wake()
    return () => {
      if (dimTimer.current) clearTimeout(dimTimer.current)
    }
  }, [wake])

  const glyph = useAnimatedStyle(() => ({ opacity: opacity.value }))
  const unreadLabel = unread > 0 ? `Open chat, ${unread} unread message${unread === 1 ? '' : 's'}` : 'Open chat'

  return (
    <View style={[styles.rail, { borderColor: t.palette.hairline, backgroundColor: withAlpha(t.palette.raised, RAIL_BACKING_ALPHA) }]}>
      {RAIL_EMOJI.map((e) => (
        <IconButton
          key={e}
          variant="plain"
          size={keySize}
          minTouch={keySize}
          haptic="none"
          accessibilityLabel={`Send ${EMOJI_NAMES[e]} reaction`}
          icon={
            <Animated.View style={glyph}>
              <Text style={styles.emoji}>{e}</Text>
            </Animated.View>
          }
          onPress={() => {
            wake()
            if (onReact(e)) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
          }}
        />
      ))}
      <Animated.View style={[styles.divider, { backgroundColor: t.palette.hairline }, glyph]} />
      <IconButton
        ref={chatButtonRef}
        variant="plain"
        size={keySize}
        minTouch={keySize}
        haptic="selection"
        accessibilityLabel={unreadLabel}
        badge={unread > 0 ? (unread > 9 ? '9+' : String(unread)) : null}
        icon={(c) => (
          <Animated.View style={glyph}>
            <MessageCircle size={20} color={unread > 0 ? t.palette.amber : c} strokeWidth={2} />
          </Animated.View>
        )}
        onPress={() => {
          wake()
          onOpenChat()
        }}
      />
    </View>
  )
})

const styles = StyleSheet.create({
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'center',
  },
  emoji: { fontSize: 22, lineHeight: 28 },
  divider: { width: 1, height: 20, marginHorizontal: 4 },
})
