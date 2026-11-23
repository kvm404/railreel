import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { AlertTriangle, HardDrive, Trash2, Database } from 'lucide-react-native'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { formatBytes } from '@/lib/storage'
import { radii, sizes } from '@/theme/tokens'

/**
 * Night Train styled cache cleanup confirmation sheet.
 * Appears when exiting a session or concluding playback with multi-gigabyte cached media on device.
 *
 * Prompts the user with the exact amount of disk space to be reclaimed, offering:
 * 1. "Delete & Leave" (Amber primary CTA) - purges local cached video/subtitles and exits
 * 2. "Keep & Leave" (neutral steel secondary CTA) - retains cache and exits
 * 3. "Cancel" - stays in the session
 *
 * The sheet is bounded to the visible window (landscape / large text) with a scrolling body and
 * pinned actions. If a delete did not actually free the space the caller passes `error`; the sheet
 * stays open with the reason inline and the primary action becomes a retry.
 */

export interface CleanupSheetProps {
  visible: boolean
  totalBytes: number
  movieBytes?: number
  subtitleBytes?: number
  onDeleteAndLeave: () => void | Promise<void>
  onKeepAndLeave: () => void | Promise<void>
  onCancel: () => void
  isDeleting?: boolean
  /**
   * Why the last delete failed (shown inline; the primary action turns into a retry). A failed
   * delete has already torn the session's media down, so the sheet LOCKS: only Retry and Leave
   * remain — no Cancel / backdrop / Back into a half-torn-down lobby.
   */
  error?: string | null
}

const ignoreBack = () => {}

export function CleanupSheet({
  visible,
  totalBytes,
  movieBytes,
  subtitleBytes,
  onDeleteAndLeave,
  onKeepAndLeave,
  onCancel,
  isDeleting = false,
  error = null,
}: CleanupSheetProps) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const compact = height < sizes.compactHeight
  const locked = error != null

  if (!visible) return null

  const formattedTotal = formatBytes(totalBytes)
  const hasSubtitles = typeof subtitleBytes === 'number' && subtitleBytes > 0
  const hasMovie = typeof movieBytes === 'number' && movieBytes > 0

  return (
    // Android Back lands on onRequestClose; mid-delete it's swallowed (like the backdrop tap) so
    // the sheet can't vanish while the purge is still running.
    <Modal visible={visible} transparent animationType="none" onRequestClose={isDeleting || locked ? ignoreBack : onCancel}>
      <View style={StyleSheet.absoluteFill}>
        {/* Dimmed backdrop */}
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(160)}
          style={[styles.backdrop, { backgroundColor: t.veils.scrim }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={isDeleting || locked ? undefined : onCancel}
            accessibilityRole="button"
            accessibilityLabel="Dismiss cleanup dialog"
          />
        </Animated.View>

        {/* Bottom sheet */}
        <View style={styles.sheetAvoider} pointerEvents="box-none">
          <Animated.View
            entering={SlideInDown.duration(280)}
            exiting={SlideOutDown.duration(200)}
            style={[
              styles.sheet,
              {
                backgroundColor: t.palette.overlay,
                borderColor: t.palette.hairline,
                paddingBottom: insets.bottom + 16,
                paddingLeft: 20 + insets.left,
                paddingRight: 20 + insets.right,
                // Never taller than the visible window: the body scrolls, the actions stay pinned.
                maxHeight: height - insets.top - 12,
              },
            ]}
          >
            {/* Handle bar */}
            <View style={[styles.handle, { backgroundColor: t.palette.hairline }]} />

            <ScrollView
              style={styles.scroll}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
            {/* Header info */}
            <View style={styles.header}>
              {compact ? null : (
                <View
                  style={[
                    styles.halo,
                    {
                      borderColor: t.palette.amber,
                      backgroundColor: t.veils.amberTint,
                    },
                  ]}
                >
                  <HardDrive size={24} color={t.palette.amber} strokeWidth={2} />
                </View>
              )}

              <Text variant="eyebrow" tone="amber" style={{ marginTop: compact ? 0 : 14 }}>
                STORAGE RECLAMATION
              </Text>

              <Text variant="title" style={styles.headline}>
                {totalBytes > 0 ? `Free up ${formattedTotal}` : 'Session Media Cache'}
              </Text>

              <Text variant="body" tone="secondary" style={styles.bodyText}>
                {totalBytes > 0
                  ? 'Local cached movie files can be purged immediately to reclaim storage space, or kept on device for quick rejoin.'
                  : 'You are about to leave the session.'}
              </Text>
            </View>

            {/* Breakdown card if sizes present */}
            {totalBytes > 0 ? (
              <View
                style={[
                  styles.breakdownCard,
                  {
                    backgroundColor: t.palette.raised,
                    borderColor: t.palette.hairline,
                  },
                ]}
              >
                {hasMovie ? (
                  <View style={styles.breakdownRow}>
                    <View style={styles.fileLabelCol}>
                      <Database size={15} color={t.palette.textTertiary} strokeWidth={1.75} />
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        railreel-movie.bin
                      </Text>
                    </View>
                    <Text variant="data" tone="primary">
                      {formatBytes(movieBytes)}
                    </Text>
                  </View>
                ) : null}

                {hasSubtitles ? (
                  <View
                    style={[
                      styles.breakdownRow,
                      hasMovie && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.palette.hairline, paddingTop: 8, marginTop: 4 },
                    ]}
                  >
                    <View style={styles.fileLabelCol}>
                      <Database size={15} color={t.palette.textTertiary} strokeWidth={1.75} />
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        railreel-subtitles.srt
                      </Text>
                    </View>
                    <Text variant="data" tone="primary">
                      {formatBytes(subtitleBytes)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {error ? (
              <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[styles.errorCard, { borderColor: t.veils.dangerBorder, backgroundColor: t.veils.dangerTint }]}
              >
                <AlertTriangle size={16} color={t.palette.danger} strokeWidth={2.25} style={{ marginTop: 2 }} />
                <Text variant="caption" tone="danger" style={{ flex: 1 }}>
                  {error}
                </Text>
              </View>
            ) : null}
            </ScrollView>

            {/* Actions */}
            <View style={styles.actions}>
              <Button
                title={isDeleting ? 'Deleting Cache…' : error ? 'Try again' : 'Delete & Leave'}
                subtitle={error ? `Retry reclaiming ${formattedTotal}` : `Purge cache and reclaim ${formattedTotal}`}
                intent="amber"
                icon={<Trash2 size={18} color={t.palette.onAmber} strokeWidth={2.2} />}
                height={60}
                onPress={onDeleteAndLeave}
                disabled={isDeleting}
              />

              <Button
                title={locked ? 'Leave anyway' : 'Keep & Leave'}
                subtitle={locked ? 'The files stay on this phone' : 'Retain cache for quick rejoin'}
                intent="neutral"
                height={52}
                onPress={onKeepAndLeave}
                disabled={isDeleting}
                style={{ marginTop: 2 }}
              />

              {locked ? null : (
              <Pressable
                onPress={onCancel}
                disabled={isDeleting}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.cancelBtn,
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityRole="button"
                accessibilityState={{ disabled: isDeleting }}
                accessibilityLabel="Cancel and stay in session"
              >
                <Text variant="caption" tone="secondary" style={styles.cancelText}>
                  Cancel and Stay in Session
                </Text>
              </Pressable>
              )}
            </View>
          </Animated.View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  sheetAvoider: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 12,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 12,
    marginBottom: 14,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  header: {
    alignItems: 'center',
    marginBottom: 16,
  },
  halo: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    marginTop: 6,
    textAlign: 'center',
  },
  bodyText: {
    marginTop: 6,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  breakdownCard: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 18,
    gap: 6,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fileLabelCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  actions: {
    gap: 8,
  },
  cancelBtn: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 2,
  },
  cancelText: {
    textAlign: 'center',
  },
})
