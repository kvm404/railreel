import { useRef, useState } from 'react'
import { Linking, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { Button, Text } from '@/ui'
import { IconButton } from '@/ui/IconButton'
import { useTheme } from '@/theme/ThemeProvider'
import { radii, sizes } from '@/theme/tokens'
import { BOTTOM_PAD, CLOSE_STRIP, SCANNER_GAP, SIDE_PAD, scannerReticle } from '@/lib/layout/scanner'
import { decodeJoinUrl, isVersionMismatch, VERSION_MISMATCH_MESSAGE } from '@/lib/protocol'
import { useBackHandler } from '@/navigation/context'

/**
 * Full-screen QR scanner overlay. Reads the host's join QR and hands back the raw railreel://
 * link. Non-RailReel codes are ignored so a stray QR can't hijack the flow. See JoinSessionScreen.
 *
 * The reticle is sized after the instruction and any action have their room (lib/layout/scanner),
 * inside the safe area; if even the smallest reticle doesn't fit, the overlay scrolls.
 */
export function QrScanner({ onScan, onClose }: { onScan: (data: string) => void; onClose: () => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height, fontScale } = useWindowDimensions()
  const [permission, requestPermission] = useCameraPermissions()
  const [hint, setHint] = useState(false)
  // A real RailReel code from another app version: say so (and how to fix it), don't call it junk.
  const [versionMismatch, setVersionMismatch] = useState(false)
  const handled = useRef(false)
  // Android Back closes the camera, not the Join screen behind it.
  useBackHandler(
    () => {
      onClose()
      return true
    },
    { layer: 'overlay' },
  )

  const onBarcode = ({ data }: { data: string }) => {
    if (handled.current || versionMismatch) return
    // Validate exactly like the paste/deep-link path so a malformed code is rejected here, not later.
    try {
      decodeJoinUrl(data.trim())
    } catch (e) {
      if (isVersionMismatch(e)) setVersionMismatch(true) // paused until the guest taps Scan again
      else setHint(true) // a QR, but not a valid RailReel join code
      return
    }
    handled.current = true
    onScan(data.trim())
  }

  const granted = permission?.granted ?? false
  const blocked = permission != null && !permission.granted && !permission.canAskAgain
  const hasAction = !granted || versionMismatch
  const reticleSize = scannerReticle({ width, height, insets, fontScale, hasAction })

  return (
    <View style={[styles.fill, { backgroundColor: t.palette.void }]}>
      {granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onBarcode}
        />
      ) : null}

      {/* dim + framing reticle */}
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[
          styles.overlay,
          {
            paddingTop: insets.top + CLOSE_STRIP,
            paddingBottom: insets.bottom + BOTTOM_PAD,
            paddingLeft: insets.left + SIDE_PAD,
            paddingRight: insets.right + SIDE_PAD,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {granted ? <View style={[styles.reticle, { width: reticleSize, height: reticleSize, borderColor: t.palette.amber }]} /> : null}
        <Text variant="data" tone="primary" style={[styles.caption, { backgroundColor: t.veils.scrim }]}>
          {granted
            ? versionMismatch
              ? VERSION_MISMATCH_MESSAGE
              : hint
                ? 'That’s not a RailReel code — point at the host’s QR'
                : 'Point at the host’s QR code'
            : blocked
              ? 'Camera access is off. Enable it in Settings to scan.'
              : 'Camera access is needed to scan the host’s code'}
        </Text>
        {granted && versionMismatch ? (
          <Button
            title="Scan again"
            intent="amber"
            height={56}
            onPress={() => {
              setVersionMismatch(false)
              setHint(false)
            }}
          />
        ) : null}
        {!granted ? (
          blocked ? (
            <Button title="Open settings" intent="amber" height={56} onPress={() => Linking.openSettings()} />
          ) : (
            <Button title="Allow camera" intent="amber" height={56} onPress={requestPermission} />
          )
        ) : null}
      </ScrollView>

      {/* The shared control: pressed wash/scale, focus ring, a real 44dp target. Clears the status
          bar / cutout / gesture bar in any orientation. */}
      <IconButton
        variant="glass"
        size={sizes.touch}
        minTouch={sizes.touch}
        haptic="none"
        icon={(c) => <X size={22} color={c} strokeWidth={2.25} />}
        accessibilityLabel="Close scanner"
        onPress={onClose}
        style={[styles.close, { top: insets.top + 12, right: insets.right + 16 }]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, zIndex: 10 },
  overlay: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: SCANNER_GAP },
  reticle: { borderWidth: 2, borderRadius: radii.xl },
  caption: { textAlign: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: radii.md, overflow: 'hidden' },
  close: { position: 'absolute' },
})
