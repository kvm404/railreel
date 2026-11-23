import { useEffect, useRef, type ReactNode } from 'react'
import { AccessibilityInfo, findNodeHandle, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated'
import { Button, Text, type ButtonIntent } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { sizes } from '@/theme/tokens'

/**
 * A full-screen in-world moment for the ends of the road — the cabin went dark, not this time,
 * lost the signal. Not an error dialog: a designed beat in the night-train language (a haloed
 * icon, a display headline, one clear way forward). See docs/design-language.md.
 *
 * Behaves as a true overlay for assistive tech: it claims accessibility focus on arrival and
 * (on iOS) marks itself modal, while screens that render it hide their own content from the
 * accessibility tree. It scrolls and switches to a side-by-side layout in short viewports
 * (landscape / large text) so the actions are never pushed off-screen.
 */

export type StatusAction = { label: string; onPress: () => void; intent?: ButtonIntent }

export function StatusScreen({
  icon,
  tone = 'amber',
  eyebrow,
  headline,
  body,
  notice,
  primary,
  secondary,
}: {
  icon: ReactNode
  tone?: 'amber' | 'cyan' | 'danger'
  eyebrow: string
  headline: string
  body: string
  /** An inline problem to surface (e.g. a failed cleanup), announced politely. */
  notice?: string | null
  primary: StatusAction
  secondary?: StatusAction
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const compact = height < sizes.compactHeight
  const sideBySide = compact && width > height
  const haloColor = tone === 'danger' ? t.palette.danger : tone === 'cyan' ? t.palette.cyan : t.palette.amber
  const halo = compact ? 72 : 108

  // Move screen-reader focus to the headline when this appears over another screen.
  const headRef = useRef<View>(null)
  useEffect(() => {
    const id = setTimeout(() => {
      const node = headRef.current ? findNodeHandle(headRef.current) : null
      if (node) AccessibilityInfo.setAccessibilityFocus(node)
    }, 350)
    return () => clearTimeout(id)
  }, [])

  const message = (
    <View style={sideBySide ? styles.messageSide : styles.message}>
      <Animated.View
        entering={FadeInDown.duration(360)}
        style={[
          styles.halo,
          { width: halo, height: halo, borderRadius: halo / 2, borderColor: haloColor, backgroundColor: `${haloColor}14` },
        ]}
      >
        {icon}
      </Animated.View>
      <View ref={headRef} accessible accessibilityRole="header" style={styles.copy}>
        <Text variant="eyebrow" style={{ color: haloColor, marginTop: compact ? 14 : 28, textAlign: 'center' }}>
          {eyebrow}
        </Text>
        <Text variant={compact ? 'title' : 'displayL'} style={styles.headline}>
          {headline}
        </Text>
      </View>
      <Text variant="body" tone="secondary" style={styles.body}>
        {body}
      </Text>
      {notice ? (
        <Text
          variant="caption"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.notice}
        >
          {notice}
        </Text>
      ) : null}
    </View>
  )

  const actions = (
    <View style={sideBySide ? styles.actionsSide : styles.actions}>
      <Button title={primary.label} intent={primary.intent ?? 'amber'} height={compact ? 56 : 64} onPress={primary.onPress} />
      {secondary ? (
        <Button title={secondary.label} intent={secondary.intent ?? 'neutral'} height={52} onPress={secondary.onPress} style={{ marginTop: 4 }} />
      ) : null}
    </View>
  )

  return (
    <Animated.View
      entering={FadeIn.duration(240)}
      accessibilityViewIsModal
      style={[
        styles.fill,
        {
          backgroundColor: t.palette.void,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 20,
          paddingLeft: sizes.gutter + insets.left,
          paddingRight: sizes.gutter + insets.right,
        },
      ]}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, sideBySide && styles.scrollSide]}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {message}
        {actions}
      </ScrollView>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  scroll: { flexGrow: 1, justifyContent: 'space-between', paddingVertical: 8 },
  scrollSide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 32 },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 220 },
  messageSide: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  copy: { alignItems: 'center' },
  halo: {
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: { textAlign: 'center', marginTop: 12 },
  body: { textAlign: 'center', marginTop: 12, maxWidth: 320 },
  notice: { textAlign: 'center', marginTop: 12, maxWidth: 320 },
  actions: { gap: 0 },
  actionsSide: { flex: 1, maxWidth: 340, gap: 0 },
})
