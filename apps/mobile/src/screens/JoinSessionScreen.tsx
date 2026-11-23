import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  FlipInXUp,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import * as Haptics from 'expo-haptics'
import { QrCode, TicketCheck, Wifi } from 'lucide-react-native'
import RailReelHost from '../../modules/railreel-host'
import { Screen } from '@/components/Screen'
import { QrScanner } from '@/components/QrScanner'
import { SessionCard } from '@/components/SessionCard'
import { SyncDots } from '@/components/SyncDots'
import { Button, Text } from '@/ui'
import { INVITE_PARAM, useInviteLinks } from '@/hooks/inviteLinks'
import { useReduceMotion } from '@/hooks/useReduceMotion'
import { useNavigation, type NavParams } from '@/navigation/context'
import { useTheme } from '@/theme/ThemeProvider'
import { radii } from '@/theme/tokens'
import { useSession } from '@/session/SessionProvider'
import { encodeJoinUrl, PROTOCOL_VERSION } from '@/lib/protocol'
import { parseInvite, type Invite } from '@/lib/links/invite'
import { DISCOVERY_EMPTY_AFTER_MS, discoveryState } from '@/lib/net/discovery'
import { isValidGuestName, MAX_GUEST_NAME_LENGTH, normalizeGuestName } from '@/lib/social/name'

/**
 * Join a session. Primary path: nearby cabins appear automatically (mDNS) — tap the one whose
 * code matches the host's flap board. QR scan and the pasted railreel:// link stay as robust
 * fallbacks (some networks block mDNS). A tapped invite link arrives prefilled and asks only for a
 * name. Discovery says what it is doing: scanning, empty (check the hotspot), or failed (retry).
 * See docs/design-language.md.
 */

/** A discovered session, ready to join with one tap. */
type Cabin = { name: string; title: string; code: string; link: string }

export function JoinSessionScreen({ params }: { params?: NavParams }) {
  const t = useTheme()
  const nav = useNavigation()
  const s = useSession()
  const invites = useInviteLinks()
  const [name, setName] = useState('')
  const [link, setLink] = useState('')
  const [scanning, setScanning] = useState(false)
  const [cabins, setCabins] = useState<Cabin[]>([])
  const [invite, setInvite] = useState<Invite | null>(() => parseInvite(typeof params?.[INVITE_PARAM] === 'string' ? (params[INVITE_PARAM] as string) : null))

  // Discovery lifecycle: `attempt` bumps on Retry; `startFailed` / `timedOut` drive the state copy.
  const [attempt, setAttempt] = useState(0)
  const [startFailed, setStartFailed] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const seen = useRef(new Set<string>())

  // A link tapped while Join is already open (or delivered just as we mount) takes over the form.
  const { pending, consume } = invites
  useEffect(() => {
    if (!pending) return
    setInvite(pending)
    setLink('')
    consume()
  }, [pending, consume])

  // Discover nearby cabins while this screen is open. The advert's TXT mirrors the QR payload;
  // the host address comes from the mDNS resolution itself.
  useEffect(() => {
    setStartFailed(false)
    setTimedOut(false)
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
      // A cabin appearing on the rail is a small moment — one tick per NEW cabin, not per refresh.
      if (!seen.current.has(e.name)) {
        seen.current.add(e.name)
        Haptics.selectionAsync().catch(() => {})
      }
      setCabins((prev) => [
        ...prev.filter((c) => c.name !== e.name),
        { name: e.name, title: txt.n || 'A nearby cabin', code: txt.c ?? '', link: joinLink },
      ])
    })
    const lost = RailReelHost.addListener('onNsdLost', (e) => {
      seen.current.delete(e.name)
      setCabins((prev) => prev.filter((c) => c.name !== e.name))
    })
    // Android reports a failed start ASYNCHRONOUSLY (onStartDiscoveryFailed, after startDiscovery()
    // already resolved), so the event — not the promise — is what flips the failed state. The
    // listener belongs to this attempt and is removed on cleanup, so a stale failure can't leak in.
    const failedEvt = RailReelHost.addListener('onNsdError', () => setStartFailed(true))
    let alive = true
    RailReelHost.startDiscovery().catch(() => {
      if (alive) setStartFailed(true)
    })
    const grace = setTimeout(() => setTimedOut(true), DISCOVERY_EMPTY_AFTER_MS)
    return () => {
      alive = false
      clearTimeout(grace)
      found.remove()
      lost.remove()
      failedEvt.remove()
      RailReelHost.stopDiscovery().catch(() => {})
    }
  }, [attempt])

  const retryDiscovery = useCallback(() => {
    seen.current.clear()
    setCabins([])
    setAttempt((n) => n + 1)
  }, [])

  // Once the store has us connected as a client, move into the lobby.
  useEffect(() => {
    if (s.role === 'client') nav.replace('Lobby')
  }, [s.role, nav])

  const connecting = s.clientPhase === 'connecting'
  // The host silently drops a join with an empty name (the guest would sit in 'requested' forever),
  // so every path that sends one is gated on a real name.
  const hasName = isValidGuestName(name)
  const guestName = normalizeGuestName(name)
  const pasted = link.trim().length > 0 ? parseInvite(link) : null
  const pasteInvalid = link.trim().length > 0 && !pasted

  const onScanned = (data: string) => {
    setScanning(false)
    s.connect(data, guestName)
  }

  // Backing out (header or hardware Back) mid-connect abandons the attempt cleanly (closes the
  // socket, stops any transfer) so a half-joined session can't linger into the next one.
  const exitJoin = () => {
    if (s.role !== 'client' && s.clientPhase === 'idle') return nav.goBack()
    s.leave()
    nav.reset('Home')
  }

  const state = discoveryState({ cabinCount: cabins.length, startFailed, elapsedMs: timedOut ? DISCOVERY_EMPTY_AFTER_MS : 0 })

  const inputStyle = [
    styles.input,
    { color: t.palette.textPrimary, borderColor: t.palette.hairline, backgroundColor: t.palette.raised, fontFamily: t.fonts.monoRegular },
  ]

  return (
    <>
      <Screen title="JOIN" scroll onBack={exitJoin}>
        <View style={styles.body}>
          {/* a tapped invite: only the name is missing */}
          {invite ? (
            <View style={[styles.inviteCard, { borderColor: t.veils.amberBorder, backgroundColor: t.veils.amberTint }]}>
              <View style={styles.inviteHead}>
                <TicketCheck size={20} color={t.palette.amber} strokeWidth={2.25} />
                <View style={{ flex: 1 }}>
                  <Text variant="eyebrow" tone="amber">
                    YOU'RE INVITED
                  </Text>
                  <Text variant="data" tone="secondary" numberOfLines={1}>
                    {invite.host}
                  </Text>
                </View>
                <Button title="Clear" intent="neutral" compact onPress={() => setInvite(null)} />
              </View>
              <Button
                title={connecting ? 'Connecting…' : 'Board this cabin'}
                subtitle={hasName ? undefined : 'Enter your name first'}
                intent="amber"
                height={60}
                disabled={!hasName || connecting}
                onPress={() => s.connect(invite.url, guestName)}
              />
            </View>
          ) : null}

          <View style={styles.field}>
            <Text variant="eyebrow" tone="muted">
              YOUR NAME
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Riya"
              autoCapitalize="words"
              autoComplete="off"
              autoCorrect={false}
              autoFocus={invite != null}
              maxLength={MAX_GUEST_NAME_LENGTH}
              returnKeyType="done"
              accessibilityLabel="Your name"
              accessibilityHint="Shown to the host and everyone in the cabin"
              placeholderTextColor={t.palette.textMuted}
              style={inputStyle}
            />
            {!hasName ? (
              <Text variant="caption" tone="muted">
                Friends see this name in the lobby and chat.
              </Text>
            ) : null}
          </View>

          {/* guided prerequisite: the hotspot comes first */}
          <View style={[styles.step, { borderColor: t.palette.hairline }]}>
            <Wifi size={18} color={t.palette.cyan} strokeWidth={2.25} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              First join the host's hotspot WiFi, then pick their cabin below.
            </Text>
          </View>

          <View style={styles.field}>
            <View style={styles.nearbyHead}>
              <Text variant="eyebrow" tone="muted">
                NEARBY CABINS
              </Text>
              {state === 'scanning' ? <SyncDots count={3} /> : null}
            </View>

            {state === 'found' ? (
              <>
                {cabins.map((c, i) => (
                  <Animated.View key={c.name} entering={FlipInXUp.duration(380).delay(i * 60)}>
                    <SessionCard
                      host={c.title}
                      title={c.code ? `CODE ${c.code}` : 'CABIN'}
                      meta="on this network"
                      status={hasName ? 'JOIN' : 'NAME?'}
                      disabled={!hasName || connecting}
                      onPress={() => s.connect(c.link, guestName)}
                    />
                  </Animated.View>
                ))}
                {!hasName ? (
                  <Text variant="caption" tone="muted">
                    Enter your name above to join a cabin.
                  </Text>
                ) : null}
              </>
            ) : (
              <DiscoveryPanel state={state} onRetry={retryDiscovery} />
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
            <Text variant="eyebrow" tone="muted">
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
            accessibilityLabel="Invite link"
            accessibilityHint="Paste the railreel link the host shared"
            placeholderTextColor={t.palette.textMuted}
            style={[inputStyle, { minHeight: 64 }, pasteInvalid && { borderColor: t.palette.danger }]}
          />
          {pasteInvalid ? (
            <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
              That doesn't look like a RailReel invite link.
            </Text>
          ) : null}
          <Button
            title={connecting ? 'Connecting…' : 'Connect'}
            subtitle={hasName ? undefined : 'Enter your name first'}
            intent="amber"
            height={56}
            disabled={!hasName || !pasted || connecting}
            onPress={() => pasted && s.connect(pasted.url, guestName)}
          />

          {s.error ? (
            <Text variant="caption" tone="amber" accessibilityLiveRegion="polite">
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

/** The non-list discovery states: scanning (with a cyan sweep), empty after the grace period, failed. */
function DiscoveryPanel({ state, onRetry }: { state: 'scanning' | 'empty' | 'failed'; onRetry: () => void }) {
  const t = useTheme()
  const failed = state === 'failed'
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.panel, { borderColor: failed ? t.veils.dangerBorder : t.palette.hairline }]}
    >
      {state === 'scanning' ? <ScanSweep /> : null}
      <Text variant="data" tone={failed ? 'danger' : 'muted'} style={styles.panelText}>
        {state === 'scanning'
          ? 'Scanning for cabins on this network…'
          : failed
            ? "Couldn't scan this network."
            : "No cabins yet — make sure you're on the host's hotspot."}
      </Text>
      {state !== 'scanning' ? (
        <>
          {failed ? (
            <Text variant="caption" tone="muted" style={styles.panelText}>
              You can still scan the QR code or paste the link below.
            </Text>
          ) : null}
          <Button title="Retry scan" intent="cyan" compact icon={<Wifi size={14} color={t.palette.cyan} strokeWidth={2.5} />} onPress={onRetry} />
        </>
      ) : null}
    </View>
  )
}

/** A thin cyan light that sweeps across the empty list while we listen — the "scan" made visible. */
function ScanSweep() {
  const t = useTheme()
  const reduced = useReduceMotion()
  const x = useSharedValue(0)
  const [w, setW] = useState(0)

  useEffect(() => {
    if (reduced || w === 0) {
      x.value = 0
      return
    }
    x.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.quad) }), -1, true)
    return () => cancelAnimation(x)
  }, [reduced, w, x])

  const style = useAnimatedStyle(() => ({
    opacity: reduced ? 0 : 0.35 + 0.5 * Math.sin(x.value * Math.PI),
    transform: [{ translateX: x.value * Math.max(0, w - 2) }],
  }))

  return (
    <View style={styles.sweepTrack} onLayout={(e) => setW(e.nativeEvent.layout.width)} pointerEvents="none">
      <Animated.View style={[styles.sweepBar, { backgroundColor: t.palette.cyan, shadowColor: t.palette.cyan }, style]} />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 16, paddingTop: 8 },
  field: { gap: 8 },
  nearbyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inviteCard: { borderWidth: 1, borderRadius: radii.lg, padding: 14, gap: 12 },
  inviteHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 10 },
  panel: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radii.lg,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 12,
    overflow: 'hidden',
  },
  panelText: { textAlign: 'center' },
  sweepTrack: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  sweepBar: {
    width: 2,
    height: '100%',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
  },
  input: { borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  rule: { flex: 1, height: 1 },
})
