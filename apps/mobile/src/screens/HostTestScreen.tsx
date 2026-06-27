import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import * as Network from 'expo-network'
import { File, Paths } from 'expo-file-system'
import { Screen } from '@/components/Screen'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import RailReelHost from '../../modules/railreel-host'

/**
 * DEV-ONLY M1 harness: measures NATIVE host throughput (NanoHTTPD range server) vs the
 * spike's 1.8 Mbps JS-bridge number. Host serves a generated test file; client downloads it
 * with expo-file-system and reports Mbps. Remove before shipping. See docs/data-plane-module.md.
 */

const PORT = 8493
const TOKEN = 'spike'
const SIZE_MB = 64

export function HostTestScreen() {
  const t = useTheme()
  const [mode, setMode] = useState<'host' | 'client'>('host')
  const [ip, setIp] = useState<string | null>(null)
  const [clientIp, setClientIp] = useState('10.63.238.250')
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const serving = useRef(false)

  const addLog = useCallback((l: string) => setLog((p) => [...p.slice(-30), l]), [])

  useEffect(() => {
    Network.getIpAddressAsync().then(setIp).catch(() => setIp(null))
    return () => {
      RailReelHost.stop().catch(() => {})
    }
  }, [])

  const toggleHost = async () => {
    if (serving.current) {
      await RailReelHost.stop().catch(() => {})
      serving.current = false
      addLog('host stopped')
      return
    }
    setBusy(true)
    setLog([])
    try {
      addLog(`generating ${SIZE_MB} MB test file…`)
      const uri = await RailReelHost.createTestFile(SIZE_MB)
      const port = await RailReelHost.start(uri, PORT, TOKEN)
      serving.current = true
      addLog(`✅ serving ${SIZE_MB} MB on :${port}`)
      addLog(`clients GET http://<ip>:${port}/movie?tk=${TOKEN}`)
    } catch (e) {
      addLog(`❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const runClient = async () => {
    setBusy(true)
    setLog([])
    const url = `http://${clientIp.trim()}:${PORT}/movie?tk=${TOKEN}`
    try {
      addLog(`downloading ${url}`)
      const dest = new File(Paths.cache, 'rr-dl.bin')
      if (dest.exists) dest.delete()
      const t0 = Date.now()
      const file = await File.downloadFileAsync(url, dest)
      const secs = (Date.now() - t0) / 1000
      const bytes = file.size ?? 0
      const mbps = secs > 0 ? (bytes * 8) / 1e6 / secs : 0
      addLog(`${(bytes / 1e6).toFixed(1)} MB in ${secs.toFixed(2)}s`)
      addLog(`✅ ${mbps.toFixed(1)} Mbps  (spike JS was ~1.8)`)
    } catch (e) {
      addLog(`❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="HOST TEST · M1" scroll>
      <View style={styles.body}>
        <View style={styles.tabs}>
          <Button title="Host" intent={mode === 'host' ? 'amber' : 'cyan'} height={52} onPress={() => setMode('host')} />
          <Button title="Client" intent={mode === 'client' ? 'amber' : 'cyan'} height={52} onPress={() => setMode('client')} />
        </View>

        {mode === 'host' ? (
          <>
            <Row label="THIS DEVICE IP" value={ip ?? '…'} />
            <Row label="SERVE" value={`${SIZE_MB} MB · :${PORT}`} />
            <Button
              title={serving.current ? 'Stop host' : busy ? 'Starting…' : 'Start host'}
              intent="amber"
              height={60}
              disabled={busy}
              onPress={toggleHost}
            />
          </>
        ) : (
          <>
            <Text variant="eyebrow" tone="tertiary">
              HOST IP
            </Text>
            <TextInput
              value={clientIp}
              onChangeText={setClientIp}
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
              placeholderTextColor={t.palette.textTertiary}
              style={[styles.input, { color: t.palette.textPrimary, borderColor: t.palette.hairline, fontFamily: t.fonts.monoRegular }]}
            />
            <Button title={busy ? 'Downloading…' : 'Download test'} intent="amber" height={60} disabled={busy} onPress={runClient} />
          </>
        )}

        <View style={[styles.log, { borderColor: t.palette.hairline, backgroundColor: t.palette.void }]}>
          {log.length === 0 ? (
            <Text variant="data" tone="tertiary">
              log…
            </Text>
          ) : (
            log.map((l, i) => (
              <Text key={i} variant="data" tone="secondary">
                {l}
              </Text>
            ))
          )}
        </View>
      </View>
    </Screen>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text variant="eyebrow" tone="tertiary">
        {label}
      </Text>
      <Text variant="data" tone="primary">
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 14, paddingTop: 8 },
  tabs: { flexDirection: 'row', gap: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  log: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4, minHeight: 150 },
})
