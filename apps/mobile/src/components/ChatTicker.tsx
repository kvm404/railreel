import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { tickerWindow, type ChatEntry } from '@/lib/social/feed'

/**
 * Subtitle-style chat: the last few FRESH lines fade in at the bottom-left of the film — like
 * subtitles from the cabin — and melt away after a few seconds. History lives in the ChatSheet;
 * the film stays king. Mono sender name in filament amber (people are warm), body in primary.
 */

const TICK_MS = 1000

export function ChatTicker({ log }: { log: ChatEntry[] }) {
  const t = useTheme()
  const [now, setNow] = useState(() => Date.now())

  // A light clock so lines age out even when nothing new arrives.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const lines = tickerWindow(log, now)
  if (lines.length === 0) return null

  return (
    <View pointerEvents="none" style={styles.stack}>
      {lines.map((l) => (
        <Animated.View key={`${l.at}-${l.from}`} entering={FadeInDown.duration(180)} exiting={FadeOut.duration(240)} style={styles.line}>
          <Text variant="data" style={{ color: t.palette.amber }} numberOfLines={1}>
            {l.from.toLowerCase()}
          </Text>
          <Text variant="caption" style={styles.text} numberOfLines={2}>
            {l.text}
          </Text>
        </Animated.View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    left: 16,
    right: 110, // stay clear of the reaction lane
    bottom: 120,
    gap: 6,
  },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  text: { flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 6 },
})
