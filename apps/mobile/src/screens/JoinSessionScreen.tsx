import { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { Radar } from 'lucide-react-native'
import { Screen } from '@/components/Screen'
import { Button, Text } from '@/ui'
import { useNavigation } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { useSession } from '@/session/SessionProvider'

/**
 * Join a session. v1 path is pasting the host's railreel:// link (or it arrives via deep link);
 * mDNS auto-discovery + QR scanning land in M6. See docs/design-language.md.
 */

export function JoinSessionScreen() {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const [name, setName] = useState('')
  const [link, setLink] = useState('')

  // Once the store has us connected as a client, move into the lobby.
  useEffect(() => {
    if (s.role === 'client') nav.replace('Lobby')
  }, [s.role, nav])

  const connecting = s.clientPhase === 'connecting'
  const canConnect = name.trim().length > 0 && link.trim().length > 0 && !connecting

  const inputStyle = [
    styles.input,
    { color: t.palette.textPrimary, borderColor: t.palette.hairline, backgroundColor: t.palette.raised, fontFamily: t.fonts.monoRegular },
  ]

  return (
    <Screen title="JOIN" scroll>
      <View style={styles.body}>
        <View style={styles.searching}>
          <Radar size={18} color={t.palette.cyan} strokeWidth={2.25} />
          <Text variant="eyebrow" tone="secondary">
            PASTE THE HOST'S LINK
          </Text>
        </View>

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
          <Text variant="eyebrow" tone="tertiary">
            JOIN LINK
          </Text>
          <TextInput
            value={link}
            onChangeText={setLink}
            placeholder="railreel://join?..."
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            placeholderTextColor={t.palette.textTertiary}
            style={[inputStyle, { minHeight: 72 }]}
          />
        </View>

        {s.error ? (
          <Text variant="caption" tone="amber">
            {s.error}
          </Text>
        ) : null}

        <View style={{ flex: 1 }} />

        <Button
          title={connecting ? 'Connecting…' : 'Connect'}
          subtitle={connecting ? undefined : 'Find the host on the hotspot'}
          intent="cyan"
          height={64}
          disabled={!canConnect}
          onPress={() => s.connect(link, name.trim())}
        />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  searching: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  field: { gap: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
})
