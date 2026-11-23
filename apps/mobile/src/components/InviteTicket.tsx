import { StyleSheet, useWindowDimensions, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { FlapText, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { qrQuietZone } from '@/lib/qr'
import { radii, sizes } from '@/theme/tokens'

/**
 * The invite as a film-strip ticket (design language "InvitePanel"): sprocket perforations down
 * both edges, the QR framed like a film cell, a perforated tear line, and a stub with the join
 * code as a large split-flap board.
 *
 * Scan reliability wins over style: the QR keeps DARK modules on a warm off-white field with a
 * full >= 4-module light quiet zone INSIDE the frame (the amber border sits outside it; reverse/
 * amber-on-dark codes are not reliably read by every camera stack). The amber lives in the frame,
 * the perforations and the code.
 */

const SPROCKETS = 11
const SPROCKET_COL = 26

export function InviteTicket({ joinUrl, code, hostIp }: { joinUrl: string; code: string | null; hostIp: string | null }) {
  const t = useTheme()
  const { width } = useWindowDimensions()
  // Fit the QR inside the ticket on narrow phones (gutters + both sprocket columns + frame border).
  // `qr` INCLUDES the quiet zone: the symbol itself is drawn smaller inside it.
  const qr = Math.max(150, Math.min(200, width - sizes.gutter * 2 - SPROCKET_COL * 2 - 4 - 24))
  const quietZone = qrQuietZone(qr, joinUrl.length)

  return (
    <View style={[styles.ticket, { borderColor: t.veils.amberBorder, backgroundColor: t.palette.raised }]}>
      <Sprockets side="left" />
      <Sprockets side="right" />

      <View style={styles.main}>
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel="Invite QR code. Friends scan this with the Scan QR code button on the Join screen."
          style={[styles.cell, { backgroundColor: t.palette.ticket, borderColor: t.palette.amberDeep }]}
        >
          <QRCode value={joinUrl} size={qr} quietZone={quietZone} color={t.palette.base} backgroundColor={t.palette.ticket} />
        </View>

        {/* perforated tear line, notched into the ticket edges */}
        <View style={styles.tear}>
          <View style={[styles.notch, styles.notchL, { backgroundColor: t.palette.base, borderColor: t.veils.amberBorder }]} />
          <View style={[styles.dash, { borderColor: t.palette.hairline }]} />
          <View style={[styles.notch, styles.notchR, { backgroundColor: t.palette.base, borderColor: t.veils.amberBorder }]} />
        </View>

        <Text variant="eyebrow" tone="muted">
          JOIN CODE
        </Text>
        <FlapText value={code ?? '····'} size={34} tone="amber" stagger={70} haptics={false} style={{ marginTop: 8 }} />
        {hostIp ? (
          <Text variant="data" tone="muted" style={{ marginTop: 10 }}>
            {hostIp}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

function Sprockets({ side }: { side: 'left' | 'right' }) {
  const t = useTheme()
  return (
    <View
      pointerEvents="none"
      style={[styles.sprockets, side === 'left' ? { left: 0 } : { right: 0 }]}
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: SPROCKETS }).map((_, i) => (
        <View key={i} style={[styles.hole, { backgroundColor: t.palette.base, borderColor: t.palette.hairline }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  ticket: { borderWidth: 1, borderRadius: radii.lg, overflow: 'hidden', paddingHorizontal: SPROCKET_COL, paddingVertical: 20 },
  main: { alignItems: 'center' },
  // No padding: the light quiet zone is part of the QR itself, so the border never eats into it.
  cell: { borderRadius: radii.sm, borderWidth: 2, overflow: 'hidden' },
  sprockets: { position: 'absolute', top: 0, bottom: 0, width: SPROCKET_COL, alignItems: 'center', justifyContent: 'space-evenly' },
  hole: { width: 8, height: 12, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  tear: { alignSelf: 'stretch', height: 24, marginVertical: 8, justifyContent: 'center' },
  dash: { borderTopWidth: 1.5, borderStyle: 'dashed', marginHorizontal: 12 },
  notch: { position: 'absolute', top: 2, width: 20, height: 20, borderRadius: 10, borderWidth: 1 },
  notchL: { left: -SPROCKET_COL - 10 },
  notchR: { right: -SPROCKET_COL - 10 },
})
