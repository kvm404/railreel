import { View, StyleSheet } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * Placeholder home screen — proves theme + safe area + gradient wiring.
 * Replaced by the real Home (Host / Join) once the UI direction is set.
 */
export function HomeScreen() {
  const t = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.fill, { backgroundColor: t.palette.bg }]}>
      <LinearGradient colors={t.gradients.hero} style={StyleSheet.absoluteFill} />
      <View style={[styles.content, { paddingTop: insets.top + t.spacing.xxxl }]}>
        <Text variant="caption" tone="accent" style={styles.kicker}>
          OFFLINE · IN SYNC · TOGETHER
        </Text>
        <Text variant="display">RailReel</Text>
        <Text variant="body" tone="muted" style={styles.tagline}>
          A private movie theater that travels with you.
        </Text>
        <View style={[styles.pill, { borderColor: t.palette.border }]}>
          <Text variant="label" tone="muted">
            Phase 0 · foundation ready
          </Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24, gap: 12 },
  kicker: { letterSpacing: 2 },
  tagline: { maxWidth: 280 },
  pill: {
    alignSelf: 'flex-start',
    marginTop: 24,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
})
