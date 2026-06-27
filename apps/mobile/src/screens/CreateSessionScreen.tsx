import { StyleSheet, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { Film, Wifi } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { SyncDots } from '@/components/SyncDots'
import { Button, FlapText, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { encodeJoinUrl, PROTOCOL_VERSION, type JoinPayload } from '@/lib/protocol'

/**
 * Host's "ready to invite" screen. (v1 mock — real movie pick + hotspot/session wiring
 * comes with the native networking layer.) Shows the QR + split-flap join code + the
 * guided hotspot step. See docs/design-language.md.
 */

// Mock session until the host server + media picker are wired up.
const JOIN_CODE = 'RL4K'
const MOCK_PAYLOAD: JoinPayload = {
  v: PROTOCOL_VERSION,
  host: '192.168.43.1',
  wsPort: 8492,
  httpPort: 8493,
  sessionId: 'demo-rl4k',
  token: 'demo-token-rl4k',
}

export function CreateSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const joinUrl = encodeJoinUrl(MOCK_PAYLOAD)

  return (
    <Screen title="NEW SESSION" scroll>
      <View style={styles.body}>
        {/* now sharing */}
        <View style={[styles.movie, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <Film size={18} color={t.palette.amber} strokeWidth={2.25} />
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="tertiary">
              NOW SHARING
            </Text>
            <Text variant="cardTitle" numberOfLines={1}>
              Dune · Part Two
            </Text>
          </View>
        </View>

        {/* invite panel — film/ticket frame around the QR */}
        <View style={[styles.invite, { borderColor: t.palette.hairline }]}>
          {/* dark modules on a light "ticket" tile with a quiet zone — scans reliably */}
          <View style={styles.qrWrap}>
            <QRCode value={joinUrl} size={172} color="#0A0E16" backgroundColor="#F5F3EC" />
          </View>
          <Text variant="eyebrow" tone="tertiary" style={{ marginTop: 18 }}>
            JOIN CODE
          </Text>
          <FlapText value={JOIN_CODE} size={34} tone="amber" stagger={70} style={{ marginTop: 8 }} />
        </View>

        {/* hotspot step */}
        <View style={[styles.step, { borderColor: t.palette.hairline }]}>
          <Wifi size={20} color={t.palette.cyan} strokeWidth={2.25} />
          <View style={{ flex: 1 }}>
            <Text variant="cardTitle">Turn on your hotspot</Text>
            <Text variant="caption" tone="tertiary">
              Name it so friends recognize it, then they scan or type the code.
            </Text>
          </View>
        </View>

        <View style={styles.waiting}>
          <SyncDots />
          <Text variant="data" tone="secondary">
            Waiting for guests…
          </Text>
        </View>

        <Button title="Open lobby" intent="amber" height={64} onPress={() => nav.navigate('Lobby')} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  movie: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderWidth: 1,
    borderRadius: 16,
  },
  invite: {
    alignItems: 'center',
    paddingVertical: 24,
    borderWidth: 1,
    borderRadius: 22,
  },
  qrWrap: { padding: 16, backgroundColor: '#F5F3EC', borderRadius: 14 },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderWidth: 1,
    borderRadius: 16,
  },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
})
