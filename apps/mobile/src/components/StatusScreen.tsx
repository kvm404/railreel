import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * A full-screen in-world moment for the ends of the road — the cabin went dark, not this time,
 * lost the signal. Not an error dialog: a designed beat in the night-train language (a haloed
 * icon, a display headline, one clear way forward). See docs/design-language.md.
 */

export type StatusAction = { label: string; onPress: () => void; intent?: 'amber' | 'cyan' }

export function StatusScreen({
  icon,
  tone = 'amber',
  eyebrow,
  headline,
  body,
  primary,
  secondary,
}: {
  icon: ReactNode
  tone?: 'amber' | 'cyan' | 'danger'
  eyebrow: string
  headline: string
  body: string
  primary: StatusAction
  secondary?: StatusAction
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const haloColor = tone === 'danger' ? t.palette.danger : tone === 'cyan' ? t.palette.cyan : t.palette.amber

  return (
    <Animated.View
      entering={FadeIn.duration(240)}
      style={[styles.fill, { backgroundColor: t.palette.void, paddingTop: insets.top, paddingBottom: insets.bottom + 20 }]}
    >
      <View style={styles.center}>
        <Animated.View entering={FadeInDown.duration(360)} style={[styles.halo, { borderColor: haloColor, backgroundColor: `${haloColor}14` }]}>
          {icon}
        </Animated.View>
        <Text variant="eyebrow" style={{ color: haloColor, marginTop: 28 }}>
          {eyebrow}
        </Text>
        <Text variant="displayL" style={styles.headline}>
          {headline}
        </Text>
        <Text variant="body" tone="secondary" style={styles.body}>
          {body}
        </Text>
      </View>

      <View style={styles.actions}>
        <Button title={primary.label} intent={primary.intent ?? 'amber'} height={64} onPress={primary.onPress} />
        {secondary ? (
          <Button title={secondary.label} intent={secondary.intent ?? 'cyan'} height={52} onPress={secondary.onPress} style={{ marginTop: 4 }} />
        ) : null}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, paddingHorizontal: 24, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  halo: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: { textAlign: 'center', marginTop: 12 },
  body: { textAlign: 'center', marginTop: 12, maxWidth: 320 },
  actions: { gap: 0 },
})
