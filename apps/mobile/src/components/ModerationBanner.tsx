import { memo, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Check, Pause, RotateCcw, X } from 'lucide-react-native'
import { Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { withAlpha } from '@/ui/alpha'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useTheme } from '@/theme/ThemeProvider'
import { radii, spacing } from '@/theme/tokens'
import { fractionLeft, secondsLeft } from '@/lib/social/countdown'
import type { PendingPlaybackRequest } from '@/session/SessionProvider'

export interface ModerationBannerProps {
  request: PendingPlaybackRequest | null
  onApprove: (requestId: string) => void
  onDismiss: (requestId: string) => void
  /** The store's auto-dismiss window (it owns the timer; this only displays it). Defaults to 10s. */
  autoDismissMs?: number
}

const TICK_MS = 250

/**
 * Host prompt for a follower's transport request (pause / rewind): who asked, what, a countdown
 * and Approve / Dismiss. The countdown is derived from the request's arrival time (see
 * lib/social/countdown), so parent re-renders can't reset it and it always agrees with the
 * session store, which owns the actual auto-dismiss. A thin amber fuse drains along the bottom
 * edge (static under reduce-motion, read live: flipping it mid-countdown stops the tween).
 */
export const ModerationBanner = memo(function ModerationBanner({
  request,
  onApprove,
  onDismiss,
  autoDismissMs = 10_000,
}: ModerationBannerProps) {
  const t = useTheme()
  const reduced = useReduceMotion()
  const [now, setNow] = useState(() => Date.now())
  const fuse = useSharedValue(1)
  const requestId = request?.requestId
  const receivedAt = request?.receivedAt ?? 0

  useEffect(() => {
    if (!requestId) return
    const start = Date.now()
    setNow(start)
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    // One UI-thread tween for the whole remaining window — no per-frame JS.
    const left = fractionLeft(receivedAt, start, autoDismissMs)
    fuse.value = left
    if (!reduced) fuse.value = withTiming(0, { duration: left * autoDismissMs, easing: Easing.linear })
    return () => {
      clearInterval(id)
      cancelAnimation(fuse)
    }
  }, [requestId, receivedAt, autoDismissMs, reduced, fuse])

  const fuseStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fuse.value }] }))

  if (!request) return null

  const isRewind = request.action === 'rewind'
  const rewindSec = request.seconds ?? 15
  const actionText = isRewind ? `wants to rewind ${rewindSec}s` : 'wants to pause'
  const left = secondsLeft(request.receivedAt, now, autoDismissMs)

  return (
    <View
      style={[styles.container, { backgroundColor: t.palette.raised, borderColor: t.palette.hairline }]}
      accessibilityRole="alert"
      accessibilityLabel={`${request.requesterName} ${actionText}`}
    >
      <View style={styles.contentRow}>
        <View style={[styles.iconContainer, { backgroundColor: withAlpha(t.palette.amber, 0.15), borderColor: t.palette.amber }]}>
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

        <Text variant="eyebrow" tone="secondary" accessibilityLabel={`${left} seconds left`}>
          {`${left}s`}
        </Text>
      </View>

      <View style={styles.actionRow}>
        <IconButton
          variant="ghost"
          size={40}
          label="Dismiss"
          radius={radii.md}
          icon={(c) => <X size={15} color={c} strokeWidth={2} />}
          accessibilityLabel={`Dismiss ${request.requesterName}'s request`}
          onPress={() => onDismiss(request.requestId)}
        />
        <IconButton
          variant="amber"
          size={40}
          label="Approve"
          radius={radii.md}
          icon={(c) => <Check size={15} color={c} strokeWidth={2.5} />}
          accessibilityLabel={isRewind ? `Approve: rewind ${rewindSec} seconds` : 'Approve: pause for everyone'}
          onPress={() => onApprove(request.requestId)}
        />
      </View>

      {reduced ? null : (
        <Animated.View pointerEvents="none" style={[styles.fuse, { backgroundColor: t.palette.amber }, fuseStyle]} />
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
    overflow: 'hidden',
    elevation: 6,
  },
  contentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: { flex: 1 },
  actionRow: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end', marginTop: 2 },
  fuse: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    transformOrigin: 'left',
  },
})
