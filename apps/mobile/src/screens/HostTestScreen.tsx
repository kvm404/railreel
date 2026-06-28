import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { File, Paths } from 'expo-file-system'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { Screen } from '@/components/Screen'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { openSyncSession, type SyncSession } from '@/net/syncClient'
import { randomBytes } from '@/net/random'
import { generateGrant, isValidSecret, parseClientMsg } from '@/lib/protocol'
import RailReelHost from '../../modules/railreel-host'

/**
 * DEV-ONLY harness for the native data plane (M1 throughput, M2 keep-awake, M3 control/sync,
 * M4 approval gating). Host serves a generated file (HTTP range) + a WS control plane; client
 * measures throughput, runs the clock handshake, receives host broadcasts, and must be approved
 * before it can download. Remove before shipping.
 */

const HTTP_PORT = 8493
const WS_PORT = 8492
// DEV: a fixed shared session token keeps two phones connectable without typing 22 chars. The
// real high-entropy token (generateToken) is unit-tested and wired into the QR flow in M5; M4's
// on-device proof is the per-client approval gate below, which can't be unit-tested.
const TOKEN = 'spike'
const SIZE_MB = 64
const KEEP_AWAKE_TAG = 'railreel-host'

type Pending = { name: string; grant: string }

export function HostTestScreen() {
  const t = useTheme()
  const [mode, setMode] = useState<'host' | 'client'>('host')
  const [clientIp, setClientIp] = useState('10.63.238.250')
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [wsClients, setWsClients] = useState(0)
  const [pending, setPending] = useState<Pending[]>([])
  const serving = useRef(false)
  const session = useRef<SyncSession | null>(null)
  // Client: this device's own download grant, minted once. Unlocked only when the host approves.
  const grant = useRef(generateGrant(randomBytes))

  const addLog = useCallback((l: string) => setLog((p) => [...p.slice(-30), l]), [])

  // Host: track WS clients + collect join requests awaiting approval.
  useEffect(() => {
    const open = RailReelHost.addListener('onWsOpen', () => setWsClients((n) => n + 1))
    const close = RailReelHost.addListener('onWsClose', () => setWsClients((n) => Math.max(0, n - 1)))
    const message = RailReelHost.addListener('onWsMessage', ({ data }) => {
      const r = parseClientMsg(data)
      if (!r.ok) return
      const msg = r.msg
      // Validate the join before it can reach approve(): a malformed/tiny grant must never enter
      // the host's approved set (a short grant would weaken the HTTP gate for everyone).
      if (msg.t === 'join' && isValidSecret(msg.grant, 22) && typeof msg.name === 'string' && msg.name.length > 0) {
        const name = msg.name.slice(0, 40)
        setPending((p) => [...p, { name, grant: msg.grant }])
        addLog(`⇢ join request from ${name}`)
      }
    })
    return () => {
      open.remove()
      close.remove()
      message.remove()
      RailReelHost.stop().catch(() => {})
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
      session.current?.close()
    }
  }, [addLog])

  const approve = async (p: Pending) => {
    try {
      await RailReelHost.approve(p.grant)
      setPending((list) => list.filter((x) => x.grant !== p.grant))
      addLog(`✅ approved ${p.name}`)
    } catch (e) {
      addLog(`❌ approve: ${String(e)}`)
    }
  }

  const toggleHost = async () => {
    if (serving.current) {
      await RailReelHost.stop().catch(() => {})
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
      serving.current = false
      setWsClients(0)
      addLog('host stopped')
      return
    }
    setBusy(true)
    setLog([])
    try {
      addLog(`generating ${SIZE_MB} MB test file…`)
      const uri = await RailReelHost.createTestFile(SIZE_MB)
      const ports = await RailReelHost.start(uri, HTTP_PORT, WS_PORT, TOKEN)
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG)
      serving.current = true
      addLog(`✅ http :${ports.httpPort} · ws :${ports.wsPort} (screen kept awake)`)
    } catch (e) {
      addLog(`❌ ${String(e)}`)
      await RailReelHost.stop().catch(() => {})
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
      serving.current = false
    } finally {
      setBusy(false)
    }
  }

  const broadcast = (isPlaying: boolean) => {
    const msg = JSON.stringify({ t: 'state', isPlaying, positionSec: 0, rate: 1, hostMonotonicMs: 0 })
    RailReelHost.broadcast(msg).catch((e) => addLog(`broadcast err: ${String(e)}`))
    addLog(`→ broadcast ${isPlaying ? 'PLAY' : 'PAUSE'}`)
  }

  const runDownload = async () => {
    setBusy(true)
    setLog([])
    // Carry the per-client grant: this 403s until the host approves it (M4 gate).
    const url = `http://${clientIp.trim()}:${HTTP_PORT}/movie?tk=${TOKEN}&g=${grant.current}`
    try {
      addLog(`downloading ${url}`)
      const dest = new File(Paths.cache, 'rr-dl.bin')
      if (dest.exists) dest.delete()
      const t0 = Date.now()
      const file = await File.downloadFileAsync(url, dest)
      const secs = (Date.now() - t0) / 1000
      const bytes = file.size ?? 0
      addLog(`${(bytes / 1e6).toFixed(1)} MB in ${secs.toFixed(2)}s → ✅ ${((bytes * 8) / 1e6 / secs).toFixed(1)} Mbps`)
    } catch (e) {
      addLog(`❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const runSync = async () => {
    setBusy(true)
    session.current?.close()
    try {
      addLog(`ws → ${clientIp.trim()}:${WS_PORT} …`)
      const s = await openSyncSession(clientIp.trim(), WS_PORT, TOKEN, (msg) =>
        addLog(`← ${msg.t === 'state' ? `state ${msg.isPlaying ? 'PLAY' : 'PAUSE'}` : JSON.stringify(msg)}`),
      )
      session.current = s
      addLog(`✅ offset ${s.estimate.offsetMs.toFixed(0)}ms · rtt ${s.estimate.rttMs.toFixed(1)}ms (${s.samples} samples)`)
      // Ask to join, presenting our grant for the host to approve (M4).
      s.send({ t: 'join', name: 'tester', token: TOKEN, grant: grant.current })
      addLog('→ join sent · listening for host broadcasts…')
    } catch (e) {
      addLog(`❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="HOST TEST · M1-M4" scroll>
      <View style={styles.body}>
        <View style={styles.tabs}>
          <Button title="Host" intent={mode === 'host' ? 'amber' : 'cyan'} height={52} onPress={() => setMode('host')} />
          <Button title="Client" intent={mode === 'client' ? 'amber' : 'cyan'} height={52} onPress={() => setMode('client')} />
        </View>

        {mode === 'host' ? (
          <>
            <Row label="SERVE" value={`${SIZE_MB} MB · http ${HTTP_PORT} · ws ${WS_PORT}`} />
            <Row label="WS CLIENTS" value={String(wsClients)} />
            <Button
              title={serving.current ? 'Stop host' : busy ? 'Starting…' : 'Start host'}
              intent="amber"
              height={60}
              disabled={busy}
              onPress={toggleHost}
            />
            {serving.current ? (
              <View style={styles.tabs}>
                <Button title="▶ PLAY" intent="cyan" height={52} onPress={() => broadcast(true)} />
                <Button title="⏸ PAUSE" intent="cyan" height={52} onPress={() => broadcast(false)} />
              </View>
            ) : null}
            {pending.map((p) => (
              <Button key={p.grant} title={`Approve ${p.name}`} intent="amber" height={52} onPress={() => approve(p)} />
            ))}
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
            <View style={styles.tabs}>
              <Button title={busy ? '…' : 'Download'} intent="amber" height={56} disabled={busy} onPress={runDownload} />
              <Button title={busy ? '…' : 'Sync (WS)'} intent="amber" height={56} disabled={busy} onPress={runSync} />
            </View>
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
