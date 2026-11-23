import { memo, useEffect, useState } from 'react'
import { StyleSheet } from 'react-native'
import Animated, { FadeInDown, FadeOut, useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { fonts } from '@/theme/tokens'
import { tickerWindow, type ChatEntry } from '@/lib/social/feed'

/**
 * Subtitle-style chat: the last few FRESH lines fade in at the bottom-left of the film — like
 * subtitles from the cabin — and melt away after a few seconds. History lives in the ChatSheet;
 * the film stays king. Sender name in filament amber (people are warm), body in primary — both in
 * Space Grotesk: this is conversation, not instrumentation.
 *
 * Placement comes from the Player's overlay layout (its reserved social region); `lift` rides
 * the chrome curtain on the UI thread so the lines glide clear of the transport when it opens.
 */

const TICK_MS = 1000

export const ChatTicker = memo(function ChatTicker({
  log,
  bottom = 120,
  left = 16,
  right = 110,
  maxHeight,
  lift,
}: {
  log: ChatEntry[]
  bottom?: number
  left?: number
  /** Keep clear of the floating-reaction lane on the right edge. */
  right?: number
  /** The room the Player's budget leaves; older lines are clipped away at the top first. */
  maxHeight?: number
  /** Extra upward offset (px), animated with the chrome. */
  lift?: SharedValue<number>
}) {
  const t = useTheme()
  const [now, setNow] = useState(() => Date.now())

  // A light clock so lines age out even when nothing new arrives.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift ? -lift.value : 0 }] }))

  const lines = tickerWindow(log, now)
  if (lines.length === 0) return null

  return (
    <Animated.View pointerEvents="none" style={[styles.stack, { bottom, left, right, maxHeight }, liftStyle]}>
      {lines.map((l) => (
        <Animated.View key={l.id} entering={FadeInDown.duration(180)} exiting={FadeOut.duration(240)} style={styles.line}>
          <Text variant="caption" style={[styles.sender, { color: t.palette.amber, textShadowColor: t.palette.void }]} numberOfLines={1}>
            {l.from}
          </Text>
          <Text variant="caption" style={[styles.text, { textShadowColor: t.palette.void }]} numberOfLines={2}>
            {l.text}
          </Text>
        </Animated.View>
      ))}
    </Animated.View>
  )
})

const styles = StyleSheet.create({
  // Anchored at the bottom: when clipped, the newest lines stay and the oldest give way.
  stack: { position: 'absolute', gap: 6, justifyContent: 'flex-end', overflow: 'hidden' },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  sender: { maxWidth: '40%', flexShrink: 0, fontFamily: fonts.bodyBold, textShadowRadius: 6 },
  text: { flexShrink: 1, textShadowRadius: 6 },
})
