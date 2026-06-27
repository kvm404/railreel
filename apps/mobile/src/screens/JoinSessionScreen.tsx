import { StyleSheet, View } from 'react-native'
import { QrCode, Radar } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { SessionCard } from '@/components/SessionCard'
import { Button, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'

/**
 * Discover nearby sessions. (v1 mock list — real mDNS discovery + QR scan come with the
 * native networking layer.) See docs/design-language.md.
 */

const MOCK_SESSIONS = [
  { host: 'Aanya', title: 'Dune · Part Two', meta: '2.1 GB · 3 aboard', status: 'OPEN' },
  { host: 'Cabin 4B', title: 'Spirited Away', meta: '1.4 GB · 5 aboard', status: 'FULL' },
  { host: 'Kabir', title: 'Interstellar', meta: '3.0 GB · 1 aboard', status: 'OPEN' },
]

export function JoinSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()

  return (
    <Screen title="JOIN">
      <View style={styles.body}>
        <View style={styles.searching}>
          <Radar size={18} color={t.palette.cyan} strokeWidth={2.25} />
          <Text variant="eyebrow" tone="secondary">
            SEARCHING NEARBY…
          </Text>
        </View>

        <View style={styles.list}>
          {MOCK_SESSIONS.map((s) => (
            <SessionCard
              key={s.host}
              host={s.host}
              title={s.title}
              meta={s.meta}
              status={s.status}
              disabled={s.status === 'FULL'}
              onPress={() => nav.navigate('Lobby', { host: s.host, title: s.title })}
            />
          ))}
        </View>

        <View style={{ flex: 1 }} />

        <Button
          title="Scan QR code"
          subtitle="Point at the host's screen"
          intent="cyan"
          height={64}
          icon={<QrCode size={22} color={t.palette.cyan} strokeWidth={2.25} />}
          onPress={() => nav.navigate('Lobby', { host: 'Aanya', title: 'Dune · Part Two' })}
        />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  searching: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  list: { gap: 12 },
})
