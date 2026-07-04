import { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { QrCode } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { QrScanner } from '@/components/QrScanner'
import { Button, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { useSession } from '@/session/SessionProvider'

/**
 * Join a session. Primary path is scanning the host's QR; pasting the railreel:// link is the
 * fallback. mDNS auto-discovery lands later in M6. See docs/design-language.md.
 */

export function JoinSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const [name, setName] = useState('')
  const [link, setLink] = useState('')
  const [scanning, setScanning] = useState(false)

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
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  rule: { flex: 1, height: 1 },
})
