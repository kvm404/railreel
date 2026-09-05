import { StyleSheet, Text, View } from 'react-native'
import { findActiveCues, type SubtitleCue } from '@/lib/subtitles'
import { fonts, palette, radii } from '@/theme/tokens'

export interface CaptionOverlayProps {
  cues: SubtitleCue[]
  currentTimeSec?: number
  positionMs?: number
  visible?: boolean
  bottomOffset?: number
}

/**
 * High-contrast on-screen caption overlay adhering to the "Night Train" visual design system.
 *
 * Renders active subtitle cues inside a semi-transparent dark container with crisp typography,
 * text shadow, and pointerEvents="none" so user taps pass cleanly through to the video controls.
 */
export function CaptionOverlay({
  cues,
  currentTimeSec,
  positionMs,
  visible = true,
  bottomOffset,
}: CaptionOverlayProps) {
  if (!visible || !cues || cues.length === 0) return null

  const posMs = positionMs ?? (currentTimeSec !== undefined ? currentTimeSec * 1000 : 0)
  const activeCues = findActiveCues(cues, posMs)

  if (activeCues.length === 0) return null

  return (
    <View
      pointerEvents="none"
      style={[styles.container, bottomOffset !== undefined && { bottom: bottomOffset }]}
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
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 48,
    alignItems: 'center',
    gap: 6,
    zIndex: 10,
  },
  cueBox: {
    backgroundColor: 'rgba(5, 7, 12, 0.82)',
    borderColor: 'rgba(40, 50, 74, 0.5)',
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
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  italic: {
    fontStyle: 'italic',
  },
  bold: {
    fontFamily: fonts.bodyBold,
    fontWeight: '700',
  },
  underline: {
    textDecorationLine: 'underline',
  },
})
