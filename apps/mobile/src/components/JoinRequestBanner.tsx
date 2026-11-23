import { memo } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { Check, UserPlus, X } from 'lucide-react-native'
import { Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { withAlpha } from '@/ui/alpha'
import { useTheme } from '@/theme/ThemeProvider'
import { radii, spacing } from '@/theme/tokens'
import { joinRequestHeadline } from '@/lib/host/admission'

export interface JoinRequestBannerProps {
  /** Pending requests, oldest first; the banner decides the first and counts the rest. */
  requests: readonly { id: string; name: string }[]
  onApprove: (id: string) => void
  onDeny: (id: string) => void
  /** Landscape: one row (icon · who · actions) so the banner takes the least height. */
  wide?: boolean
  onLayout?: (e: LayoutChangeEvent) => void
}

/**
 * Host notice in the Player for someone asking to board mid-show — the door is a host action
 * wherever the host is, not only in the Lobby. A sibling of ModerationBanner (same raised plate,
 * amber = people), but with no countdown: a join request waits until the host decides. The
 * notice is a polite live region, so TalkBack announces a new arrival without stealing focus.
 */
export const JoinRequestBanner = memo(function JoinRequestBanner({
  requests,
  onApprove,
  onDeny,
  wide = false,
  onLayout,
}: JoinRequestBannerProps) {
  const t = useTheme()
  const first = requests[0]
  if (!first) return null
  const head = joinRequestHeadline(requests.map((r) => r.name))

  const who = (
    <View
      style={[styles.who, wide && styles.whoWide]}
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${head.name} ${head.detail}`}
    >
      <View style={[styles.icon, { backgroundColor: withAlpha(t.palette.amber, 0.15), borderColor: t.palette.amber }]}>
        <UserPlus size={18} color={t.palette.amber} strokeWidth={2.2} />
      </View>
      <View style={styles.text}>
        <Text variant="cardTitle" tone="primary" numberOfLines={1}>
          {head.name}
        </Text>
        <Text variant="caption" tone="amber" numberOfLines={1}>
          {head.detail}
        </Text>
      </View>
    </View>
  )
  const actions = (
    <View style={styles.actions}>
      <IconButton
        variant="ghost"
        size={40}
        label="Deny"
        radius={radii.md}
        icon={(c) => <X size={15} color={c} strokeWidth={2} />}
        accessibilityLabel={`Deny ${first.name}`}
        onPress={() => onDeny(first.id)}
      />
      <IconButton
        variant="amber"
        size={40}
        label="Approve"
        radius={radii.md}
        icon={(c) => <Check size={15} color={c} strokeWidth={2.5} />}
        accessibilityLabel={`Let ${first.name} board`}
        onPress={() => onApprove(first.id)}
      />
    </View>
  )

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.container,
        wide && styles.containerWide,
        { backgroundColor: t.palette.raised, borderColor: withAlpha(t.palette.amber, 0.5) },
      ]}
    >
      {who}
      {actions}
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
    elevation: 6,
  },
  // Landscape: one row, and no wider than it needs to be over the film.
  containerWide: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, alignSelf: 'center', maxWidth: 560, width: '100%' },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  whoWide: { flex: 1, minWidth: 0 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
})
