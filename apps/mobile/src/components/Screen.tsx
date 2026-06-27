import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { useNavigation } from '@/navigation/context'

/**
 * Standard screen frame: transparent (the persistent WindowAtmosphere shows through),
 * safe-area aware, with an optional back-affordance header. See docs/design-language.md.
 */
export function Screen({
  title,
  children,
  showBack = true,
}: {
  title?: string
  children: ReactNode
  showBack?: boolean
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const nav = useNavigation()

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }]}>
      {(showBack || title) && (
        <View style={styles.header}>
          {showBack && nav.canGoBack ? (
            <Pressable
              onPress={nav.goBack}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={[styles.back, { borderColor: t.palette.hairline }]}
            >
              <ChevronLeft size={20} color={t.palette.textSecondary} strokeWidth={2.25} />
            </Pressable>
          ) : (
            <View style={styles.backSpacer} />
          )}
          {title ? (
            <Text variant="eyebrow" tone="secondary">
              {title}
            </Text>
          ) : null}
          <View style={styles.backSpacer} />
        </View>
      )}
      <View style={styles.body}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, paddingHorizontal: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backSpacer: { width: 40, height: 40 },
  body: { flex: 1 },
})
