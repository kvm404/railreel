import type { ReactNode } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated'
import { Button, Text, type ButtonIntent } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'

/**
 * A small in-world confirmation sheet for consequential exits ("End the session for everyone?").
 * Same material as the cleanup sheet: a dimmed scrim, an overlay-surface bottom sheet that never
 * outgrows the window (the body scrolls, the actions stay pinned), Back and a backdrop tap cancel.
 */
export function ConfirmSheet({
  visible,
  icon,
  title,
  body,
  confirmLabel,
  confirmIntent = 'danger',
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  visible: boolean
  icon?: ReactNode
  title: string
  body: string
  confirmLabel: string
  confirmIntent?: ButtonIntent
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()

  if (!visible) return null

  return (
    <Modal visible transparent animationType="none" onRequestClose={onCancel}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(160)}
          style={[StyleSheet.absoluteFill, { backgroundColor: t.veils.scrim }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
          />
        </Animated.View>

        <View style={styles.avoider} pointerEvents="box-none">
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
                maxHeight: height - insets.top - 12,
              },
            ]}
          >
            <View style={[styles.handle, { backgroundColor: t.palette.hairline }]} />
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              <View style={styles.header}>
                {icon}
                <Text variant="title" style={styles.title} accessibilityRole="header">
                  {title}
                </Text>
                <Text variant="body" tone="secondary" style={styles.body}>
                  {body}
                </Text>
              </View>
            </ScrollView>
            <View style={styles.actions}>
              <Button title={confirmLabel} intent={confirmIntent} height={56} onPress={onConfirm} />
              <Button title={cancelLabel} intent="neutral" height={52} onPress={onCancel} />
            </View>
          </Animated.View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  avoider: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 12,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  header: { alignItems: 'center', marginBottom: 18, gap: 8 },
  title: { textAlign: 'center' },
  body: { textAlign: 'center', paddingHorizontal: 8 },
  actions: { gap: 8 },
})
