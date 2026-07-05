import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { QrCode, TrainFront } from 'lucide-react-native'
import RailReelHost from '../../modules/railreel-host'
import { Screen } from '@/components/Screen'
import { QrScanner } from '@/components/QrScanner'
import { SyncDots } from '@/components/SyncDots'
import { Button, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { useSession } from '@/session/SessionProvider'
import { encodeJoinUrl, PROTOCOL_VERSION } from '@/lib/protocol'

/**
 * Join a session. Primary path: nearby cabins appear automatically (mDNS) — tap the one whose
 * code matches the host's flap board. QR scan and the pasted railreel:// link stay as robust
 * fallbacks (some networks block mDNS). See docs/design-language.md.
 */

/** A discovered session, ready to join with one tap. */
type Cabin = { name: string; title: string; code: string; link: string }

export function JoinSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const [name, setName] = useState('')
  const [link, setLink] = useState('')
  const [scanning, setScanning] = useState(false)
  const [cabins, setCabins] = useState<Cabin[]>([])

  // Discover nearby cabins while this screen is open. The advert's TXT mirrors the QR payload;
  // the host address comes from the mDNS resolution itself.
  useEffect(() => {
    const found = RailReelHost.addListener('onNsdFound', (e) => {
      const txt = e.txt ?? {}
      const httpPort = Number(txt.h)
      if (!txt.t || !txt.s || !Number.isFinite(httpPort)) return
      const joinLink = encodeJoinUrl({
        v: Number(txt.v) || PROTOCOL_VERSION,
        host: e.host,
        wsPort: e.port,
        httpPort,
        sessionId: txt.s,
        token: txt.t,
      })
      setCabins((prev) => [
        ...prev.filter((c) => c.name !== e.name),
        { name: e.name, title: txt.n || 'A nearby cabin', code: txt.c ?? '', link: joinLink },
      ])
    })
    const lost = RailReelHost.addListener('onNsdLost', (e) => setCabins((prev) => prev.filter((c) => c.name !== e.name)))
    RailReelHost.startDiscovery().catch(() => {})
    return () => {
      found.remove()
      lost.remove()
      RailReelHost.stopDiscovery().catch(() => {})
    }
  }, [])

  // Once the store has us connected as a client, move into the lobby.
  useEffect(() => {
    if (s.role === 'client') nav.replace('Lobby')
  }, [s.role, nav])

  const connecting = s.clientPhase === 'connecting'
  const hasName = name.trim().length > 0

  const onScanned = (data: string) => {
    setScanning(false)
    s.connect(data, name.trim())
  }

  // Backing out mid-connect abandons the attempt cleanly (closes the socket, stops any transfer)
  // so a half-joined session can't linger into the next one.
  const exitJoin = () => {
    if (s.role === 'client' || s.clientPhase !== 'idle') s.leave()
    nav.goBack()
  }

  const inputStyle = [
    styles.input,
    { color: t.palette.textPrimary, borderColor: t.palette.hairline, backgroundColor: t.palette.raised, fontFamily: t.fonts.monoRegular },
  ]

  return (
    <>
      <Screen title="JOIN" scroll onBack={exitJoin}>
        <View style={styles.body}>
        <View style={styles.field}>
          <Text variant="eyebrow" tone="tertiary">
            YOUR NAME
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Riya"
            autoCapitalize="words"
            placeholderTextColor={t.palette.textTertiary}
            style={inputStyle}
          />
        </View>

        <View style={styles.field}>
          <View style={styles.nearbyHead}>
            <Text variant="eyebrow" tone="tertiary">
              NEARBY CABINS
            </Text>
            {cabins.length === 0 ? <SyncDots count={3} /> : null}
          </View>
          {cabins.length === 0 ? (
            <View style={[styles.scanning, { borderColor: t.palette.hairline }]}>
              <Text variant="data" tone="tertiary">
                Scanning for cabins on this network…
              </Text>
            </View>
          ) : (
            cabins.map((c) => (
              <Pressable
                key={c.name}
                disabled={!hasName || connecting}
                onPress={() => s.connect(c.link, name.trim())}
                style={({ pressed }) => [
                  styles.cabin,
                  { borderColor: t.palette.hairline, backgroundColor: t.palette.raised },
                  pressed && { transform: [{ scale: 0.98 }] },
                  !hasName && { opacity: 0.5 },
                ]}
              >
                <TrainFront size={20} color={t.palette.cyan} strokeWidth={2} />
                <View style={{ flex: 1 }}>
                  <Text variant="cardTitle" numberOfLines={1}>
                    {c.title}
                  </Text>
                  <Text variant="caption" tone="tertiary">
                    {hasName ? 'Tap to join' : 'Enter your name first'}
                  </Text>
                </View>
                <Text variant="data" tone="amber">
                  {c.code}
                </Text>
              </Pressable>
            ))
          )}
        </View>

        <Button
          title="Scan QR code"
          subtitle={hasName ? "Point at the host's screen" : 'Enter your name first'}
          intent="cyan"
          height={64}
          icon={<QrCode size={22} color={t.palette.cyan} strokeWidth={2.25} />}
          disabled={!hasName || connecting}
          onPress={() => setScanning(true)}
        />

        <View style={styles.orRow}>
          <View style={[styles.rule, { backgroundColor: t.palette.hairline }]} />
          <Text variant="eyebrow" tone="tertiary">
            OR PASTE THE LINK
          </Text>
          <View style={[styles.rule, { backgroundColor: t.palette.hairline }]} />
        </View>

        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="railreel://join?..."
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholderTextColor={t.palette.textTertiary}
          style={[inputStyle, { minHeight: 64 }]}
        />
        <Button
          title={connecting ? 'Connecting…' : 'Connect'}
          intent="amber"
          height={56}
          disabled={!hasName || link.trim().length === 0 || connecting}
          onPress={() => s.connect(link, name.trim())}
        />

        {s.error ? (
          <Text variant="caption" tone="amber">
            {s.error}
          </Text>
        ) : null}
        </View>
      </Screen>

      {/* Sibling of Screen so the camera layer is truly full-screen (not inside the padded body). */}
      {scanning ? <QrScanner onScan={onScanned} onClose={() => setScanning(false)} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  field: { gap: 8 },
  nearbyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scanning: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  cabin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderWidth: 1,
    borderRadius: 14,
  },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  rule: { flex: 1, height: 1 },
})
