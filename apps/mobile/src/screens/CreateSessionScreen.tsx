import { StyleSheet, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { Film, Wifi } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { SyncDots } from '@/components/SyncDots'
import { Button, FlapText, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { useSession } from '@/session/SessionProvider'

/**
 * Host's "ready to invite" screen. Opens the movie picker, starts the native HTTP+WS servers,
 * and shows the real QR + split-flap join code + the guided hotspot step. The session lives in
 * the store so it survives the trip into the lobby. See docs/design-language.md.
 */

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '—'
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

export function CreateSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()

  const guests = s.participants.filter((p) => p.id !== 'host').length

  // Backing out of a live (or starting) session tears it down — servers, keep-awake, roster —
  // so the next session starts clean instead of inheriting a zombie.
  const exitSession = () => {
    if (s.hostPhase !== 'idle') s.leave()
    nav.goBack()
  }

  // Before the session is live: a deliberate "choose a movie" step. (We open the picker on a tap
  // rather than on mount so it can't interrupt the screen-entry animation — that left the screen
  // mounted but invisible.)
  if (s.hostPhase !== 'live') {
    const starting = s.hostPhase === 'starting'
    return (
      <Screen title="NEW SESSION" onBack={exitSession}>
        <View style={styles.center}>
          <Film size={40} color={t.palette.amber} strokeWidth={1.75} />
          <Text variant="title" style={{ textAlign: 'center' }}>
            Share a movie with the cabin
          </Text>
          <Text variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
            Pick a video on this phone — friends download their own copy and watch in sync.
          </Text>
          {s.error ? (
            <Text variant="caption" tone="amber" style={{ textAlign: 'center' }}>
              {s.error}
            </Text>
          ) : null}
          {starting ? <SyncDots /> : null}
          <Button
            title={starting ? 'Opening…' : s.error ? 'Try another movie' : 'Choose a movie'}
            intent="amber"
            height={64}
            disabled={starting}
            onPress={() => s.startHost()}
          />
        </View>
      </Screen>
    )
  }

  return (
    <Screen title="NEW SESSION" scroll onBack={exitSession}>
      <View style={styles.body}>
        {/* now sharing */}
        <View style={[styles.movie, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}>
          <Film size={18} color={t.palette.amber} strokeWidth={2.25} />
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="tertiary">
              NOW SHARING
            </Text>
            <Text variant="cardTitle" numberOfLines={1}>
              {s.movie?.title ?? 'Movie'}
            </Text>
          </View>
          <Text variant="data" tone="tertiary">
            {fmtSize(s.movie?.sizeBytes ?? 0)}
          </Text>
        </View>

        {/* invite panel — film/ticket frame around the QR (only once we have a reachable address) */}
        {s.joinUrl ? (
          <View style={[styles.invite, { borderColor: t.palette.hairline }]}>
            <View style={styles.qrWrap}>
              <QRCode value={s.joinUrl} size={172} color="#0A0E16" backgroundColor="#F5F3EC" />
            </View>
            <Text variant="eyebrow" tone="tertiary" style={{ marginTop: 18 }}>
              JOIN CODE
            </Text>
            <FlapText value={s.joinCode ?? '····'} size={34} tone="amber" stagger={70} style={{ marginTop: 8 }} />
            {s.hostIp ? (
              <Text variant="data" tone="tertiary" style={{ marginTop: 10 }}>
                {s.hostIp}
              </Text>
            ) : null}
          </View>
        ) : (
          <View style={[styles.invite, { borderColor: t.palette.hairline, gap: 14 }]}>
            <Text variant="cardTitle" style={{ textAlign: 'center' }}>
              Turn on your hotspot
            </Text>
            <Text variant="caption" tone="tertiary" style={{ textAlign: 'center', paddingHorizontal: 20 }}>
              No reachable address yet. Enable your hotspot, then refresh to show the invite code.
            </Text>
            <Button title="Refresh link" intent="cyan" height={52} onPress={s.refreshJoin} />
          </View>
        )}

        {/* hotspot step */}
        <View style={[styles.step, { borderColor: t.palette.hairline }]}>
          <Wifi size={20} color={t.palette.cyan} strokeWidth={2.25} />
          <View style={{ flex: 1 }}>
            <Text variant="cardTitle">Keep your hotspot on</Text>
            <Text variant="caption" tone="tertiary">
              Name it so friends recognize it, then they scan or paste the code.
            </Text>
          </View>
        </View>

        <View style={styles.waiting}>
          <SyncDots />
          <Text variant="data" tone="secondary">
            {guests > 0 ? `${guests} aboard` : 'Waiting for guests…'}
          </Text>
        </View>

        {s.hostWarning ? (
          <Text variant="caption" tone="amber" style={{ textAlign: 'center' }}>
            {s.hostWarning}
          </Text>
        ) : null}

        <Button title="Open lobby" intent="amber" height={64} onPress={() => nav.navigate('Lobby')} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 24 },
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
