import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Check, Pause, RotateCcw, X } from 'lucide-react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { radii, spacing } from '@/theme/tokens'
import type { PendingPlaybackRequest } from '@/session/SessionProvider'

export interface ModerationBannerProps {
  request: PendingPlaybackRequest | null
  onApprove: (requestId: string) => void
  onDismiss: (requestId: string) => void
  /** Auto-dismiss timeout in milliseconds. Defaults to 10,000 (10s). */
  autoDismissMs?: number
}

/**
 * Host interactive notification banner adhering to the "Night Train" visual design system.
 *
 * Appears when a follower submits a transport request (pause or rewind). Displays the requester's
 * name, requested action, countdown, and Approve / Dismiss action buttons. Automatically dismisses
 * after 10 seconds if unhandled.
 */
export function ModerationBanner({
  request,
  onApprove,
  onDismiss,
  autoDismissMs = 10_000,
}: ModerationBannerProps) {
  const t = useTheme()
  const [secondsRemaining, setSecondsRemaining] = useState(Math.ceil(autoDismissMs / 1000))

  useEffect(() => {
    if (!request) return

    setSecondsRemaining(Math.ceil(autoDismissMs / 1000))

    const countdownInterval = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 1 ? prev - 1 : 0))
    }, 1000)

    const dismissTimer = setTimeout(() => {
      onDismiss(request.requestId)
    }, autoDismissMs)

    return () => {
      clearInterval(countdownInterval)
      clearTimeout(dismissTimer)
    }
  }, [request?.requestId, autoDismissMs, onDismiss])

  if (!request) return null

  const isRewind = request.action === 'rewind'
  const rewindSec = request.seconds ?? 15
  const actionText = isRewind ? `wants to rewind ${rewindSec}s` : 'wants to pause'

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
    >
      <View style={styles.contentRow}>
        <View
          style={[
            styles.iconContainer,
            { backgroundColor: 'rgba(255, 178, 92, 0.15)', borderColor: t.palette.amber },
          ]}
        >
          {isRewind ? (
            <RotateCcw size={18} color={t.palette.amber} strokeWidth={2.2} />
          ) : (
            <Pause size={18} color={t.palette.amber} strokeWidth={2.2} />
          )}
        </View>

        <View style={styles.textContainer}>
          <Text variant="cardTitle" tone="primary" numberOfLines={1}>
            {request.requesterName}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {actionText}
          </Text>
        </View>

        <View style={styles.timerBadge}>
          <Text variant="eyebrow" tone="tertiary">
            {secondsRemaining}s
          </Text>
        </View>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          onPress={() => onDismiss(request.requestId)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss playback request"
          style={[styles.btn, styles.dismissBtn, { borderColor: t.palette.hairline }]}
        >
          <X size={15} color={t.palette.textSecondary} strokeWidth={2} />
          <Text variant="caption" tone="secondary" style={styles.btnText}>
            Dismiss
          </Text>
        </Pressable>

        <Pressable
          onPress={() => onApprove(request.requestId)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Approve playback request"
          style={[
            styles.btn,
            styles.approveBtn,
            { backgroundColor: t.palette.amber, borderColor: t.palette.amberGlow },
          ]}
        >
          <Check size={15} color="#0A0E16" strokeWidth={2.5} />
          <Text variant="caption" style={[styles.btnText, { color: '#0A0E16', fontWeight: '700' }]}>
            Approve
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    flex: 1,
  },
  timerBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginTop: 2,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    height: 34,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  dismissBtn: {
    backgroundColor: 'transparent',
  },
  approveBtn: {},
  btnText: {
    fontFamily: 'SpaceGrotesk_500Medium',
  },
})
