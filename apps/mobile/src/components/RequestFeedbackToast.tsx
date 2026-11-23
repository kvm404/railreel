import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { palette, radii, spacing } from '@/theme/tokens'
import { requestToastCopy, type RequestToastTone } from '@/lib/player/requestToast'
import type { PlaybackRequestStatus } from '@/session/SessionProvider'

/** The store's statuses, plus the finer outcomes it reports once they exist ('declined' / 'expired'). */
export type RequestToastStatus = PlaybackRequestStatus | 'declined' | 'expired'

export interface RequestFeedbackToastProps {
  status: RequestToastStatus
  onDismiss?: () => void
  /** Auto-fade duration in milliseconds for terminal states. Defaults to 3000ms. */
  autoFadeMs?: number
}

/**
 * A follower's request, from "asked" to its outcome: who decided (the host passed), or that
 * nobody did (no answer yet — ask again). Copy lives in lib/player/requestToast; a status this
 * build doesn't know renders nothing. Cyan only for the approval (sync is about to happen); a
 * decision or a timeout is neutral, never a red error.
 */
export function RequestFeedbackToast({ status, onDismiss, autoFadeMs = 3000 }: RequestFeedbackToastProps) {
  const t = useTheme()
  const copy = requestToastCopy(status)
  const terminal = copy?.terminal ?? false

  useEffect(() => {
    if (!terminal) return
    const timer = setTimeout(() => onDismiss?.(), autoFadeMs)
    return () => clearTimeout(timer)
  }, [status, terminal, autoFadeMs, onDismiss])

  if (!copy) return null

  const dot: Record<RequestToastTone, string> = {
    pending: t.palette.amber,
    sync: t.palette.cyan,
    neutral: t.palette.textSecondary,
  }

  return (
    <View
      style={[styles.container, { backgroundColor: t.palette.raised, borderColor: t.palette.hairline }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.dot, { backgroundColor: dot[copy.tone] }]} />
      <Text variant="caption" tone="primary">
        {copy.message}
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
    gap: spacing.sm,
    shadowColor: palette.black,
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
})
