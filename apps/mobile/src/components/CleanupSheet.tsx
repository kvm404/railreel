import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { HardDrive, Trash2, Database } from 'lucide-react-native'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { formatBytes } from '@/lib/storage'

/**
 * Night Train styled cache cleanup confirmation sheet.
 * Appears when exiting a session or concluding playback with multi-gigabyte cached media on device.
 *
 * Prompts the user with the exact amount of disk space to be reclaimed, offering:
 * 1. "Delete & Leave" (Amber primary CTA) - purges local cached video/subtitles and exits
 * 2. "Keep & Leave" (Cyan secondary CTA) - retains cache for quick rejoin and exits
 * 3. "Cancel" - stays in the session
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
}

export function CleanupSheet({
  visible,
  totalBytes,
  movieBytes,
  subtitleBytes,
  onDeleteAndLeave,
  onKeepAndLeave,
  onCancel,
  isDeleting = false,
}: CleanupSheetProps) {
  const t = useTheme()
  const insets = useSafeAreaInsets()

  if (!visible) return null

  const formattedTotal = formatBytes(totalBytes)
  const hasSubtitles = typeof subtitleBytes === 'number' && subtitleBytes > 0
  const hasMovie = typeof movieBytes === 'number' && movieBytes > 0

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <View style={StyleSheet.absoluteFill}>
        {/* Dimmed backdrop */}
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(160)}
          style={[styles.backdrop, { backgroundColor: 'rgba(5, 7, 12, 0.78)' }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={isDeleting ? undefined : onCancel}
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
              },
            ]}
          >
            {/* Handle bar */}
            <View style={[styles.handle, { backgroundColor: t.palette.hairline }]} />

            {/* Header info */}
            <View style={styles.header}>
              <View
                style={[
                  styles.halo,
                  {
                    borderColor: t.palette.amber,
                    backgroundColor: `${t.palette.amber}15`,
                  },
                ]}
              >
                <HardDrive size={24} color={t.palette.amber} strokeWidth={2} />
              </View>

              <Text variant="eyebrow" style={{ color: t.palette.amber, marginTop: 14 }}>
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

            {/* Actions */}
            <View style={styles.actions}>
              <Button
                title={isDeleting ? 'Deleting Cache…' : 'Delete & Leave'}
                subtitle={`Purge cache and reclaim ${formattedTotal}`}
                intent="amber"
                icon={<Trash2 size={18} color={t.palette.onAmber} strokeWidth={2.2} />}
                height={60}
                onPress={onDeleteAndLeave}
                disabled={isDeleting}
              />

              <Button
                title="Keep & Leave"
                subtitle="Retain cache for quick rejoin"
                intent="cyan"
                height={52}
                onPress={onKeepAndLeave}
                disabled={isDeleting}
                style={{ marginTop: 2 }}
              />

              <Pressable
                onPress={onCancel}
                disabled={isDeleting}
                hitSlop={12}
                style={({ pressed }) => [
                  styles.cancelBtn,
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Cancel and stay in session"
              >
                <Text variant="caption" tone="secondary" style={styles.cancelText}>
                  Cancel and Stay in Session
                </Text>
              </Pressable>
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
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 12,
    paddingHorizontal: 20,
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
    borderRadius: 14,
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
