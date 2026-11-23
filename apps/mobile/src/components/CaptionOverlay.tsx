import { memo, useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { findActiveCues, type SubtitleCue } from '@/lib/subtitles'
import type { PlayheadStore } from '@/lib/player/playhead'
import { withAlpha } from '@/ui/alpha'
import { fonts, palette, radii } from '@/theme/tokens'

export interface CaptionOverlayProps {
  cues: SubtitleCue[]
  /** Live position source; the overlay re-renders only when the active cue set changes. */
  playhead?: PlayheadStore
  /** Static position (used when no playhead is given). */
  currentTimeSec?: number
  positionMs?: number
  visible?: boolean
  /** Resting distance from the bottom edge (the reserved caption region). */
  bottomOffset?: number
  /** Horizontal safe insets (landscape cutouts). */
  left?: number
  right?: number
  /** Extra upward offset (px), animated with the chrome curtain on the UI thread. */
  lift?: SharedValue<number>
}

const cueKey = (cues: SubtitleCue[]): string => cues.map((c) => c.id).join('|')

/** Active cues at the playhead, as React state that changes only when the cue SET changes. */
function useActiveCues(cues: SubtitleCue[], playhead: PlayheadStore | undefined, fallbackMs: number): SubtitleCue[] {
  const [active, setActive] = useState<SubtitleCue[]>(() =>
    findActiveCues(cues, playhead ? playhead.get() * 1000 : fallbackMs),
  )
  useEffect(() => {
    const read = (sec: number) => {
      const next = findActiveCues(cues, sec * 1000)
      setActive((prev) => (cueKey(prev) === cueKey(next) ? prev : next))
    }
    if (!playhead) {
      read(fallbackMs / 1000)
      return
    }
    read(playhead.get())
    return playhead.subscribe(read)
  }, [cues, playhead, fallbackMs])
  return active
}

/**
 * High-contrast on-screen captions in the "Night Train" system: a dark void plate, crisp
 * type, text shadow, and pointerEvents="none" so taps pass through to the film. Positioned in
 * the Player's reserved caption region (never under the transport or the reaction rail) and
 * lifted with the chrome curtain. No zIndex of its own — the chat sheet is the top layer.
 */
export const CaptionOverlay = memo(function CaptionOverlay({
  cues,
  playhead,
  currentTimeSec,
  positionMs,
  visible = true,
  bottomOffset,
  left = 20,
  right = 20,
  lift,
}: CaptionOverlayProps) {
  const fallbackMs = positionMs ?? (currentTimeSec !== undefined ? currentTimeSec * 1000 : 0)
  const activeCues = useActiveCues(visible ? cues : EMPTY, playhead, fallbackMs)
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift ? -lift.value : 0 }] }))

  if (!visible || activeCues.length === 0) return null

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.container, { left, right }, bottomOffset !== undefined && { bottom: bottomOffset }, liftStyle]}
    >
      {activeCues.map((cue, cueIdx) => (
        <View key={`${cue.id}-${cueIdx}`} style={styles.cueBox}>
          {cue.lines && cue.lines.length > 0 ? (
            cue.lines.map((line, lineIdx) => (
              <Text key={lineIdx} style={styles.textLine}>
                {line.spans.map((span, spanIdx) => (
                  <Text
                    key={spanIdx}
                    style={[
                      styles.spanText,
                      span.italic && styles.italic,
                      span.bold && styles.bold,
                      span.underline && styles.underline,
                    ]}
                  >
                    {span.text}
                  </Text>
                ))}
              </Text>
            ))
          ) : (
            <Text style={[styles.textLine, styles.spanText]}>{cue.text}</Text>
          )}
        </View>
      ))}
    </Animated.View>
  )
})

const EMPTY: SubtitleCue[] = []

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 48,
    alignItems: 'center',
    gap: 6,
  },
  cueBox: {
    backgroundColor: withAlpha(palette.void, 0.82),
    borderColor: withAlpha(palette.hairline, 0.5),
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.sm,
    maxWidth: '92%',
  },
  textLine: {
    textAlign: 'center',
  },
  spanText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 17,
    lineHeight: 23,
    color: palette.textPrimary,
    textShadowColor: withAlpha(palette.black, 0.95),
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  italic: {
    fontStyle: 'italic',
  },
  bold: {
    fontFamily: fonts.bodyBold,
  },
  underline: {
    textDecorationLine: 'underline',
  },
})
