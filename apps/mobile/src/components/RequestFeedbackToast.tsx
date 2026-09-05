import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { radii, spacing } from '@/theme/tokens'
import type { PlaybackRequestStatus } from '@/session/SessionProvider'

export interface RequestFeedbackToastProps {
  status: PlaybackRequestStatus
  onDismiss?: () => void
  /** Auto-fade duration in milliseconds for terminal states (dismissed, approved). Defaults to 3000ms. */
  autoFadeMs?: number
}

/**
 * Visual confirmation toast for followers showing playback request transmission and resolution.
 * Adheres to the "Night Train" visual design system.
 */
export function RequestFeedbackToast({
  status,
  onDismiss,
  autoFadeMs = 3000,
}: RequestFeedbackToastProps) {
  const t = useTheme()

  useEffect(() => {
    if (status === 'dismissed' || status === 'approved') {
      const timer = setTimeout(() => {
        onDismiss?.()
      }, autoFadeMs)
      return () => clearTimeout(timer)
    }
  }, [status, autoFadeMs, onDismiss])

  if (status === 'idle') return null

  let message = 'Playback request sent to host...'
  let dotColor: string = t.palette.amber

  if (status === 'approved') {
    message = 'Request approved! Synchronizing...'
    dotColor = t.palette.cyan
  } else if (status === 'dismissed') {
    message = 'Request dismissed by host'
    dotColor = t.palette.danger
  }

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: t.palette.raised,
          borderColor: t.palette.hairline,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text variant="caption" tone="primary" style={styles.text}>
        {message}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    fontFamily: 'SpaceGrotesk_500Medium',
  },
})
