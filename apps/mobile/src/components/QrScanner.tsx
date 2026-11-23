import { useRef, useState } from 'react'
import { Linking, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { radii, sizes } from '@/theme/tokens'
import { decodeJoinUrl, isVersionMismatch, VERSION_MISMATCH_MESSAGE } from '@/lib/protocol'
import { useBackHandler } from '@/navigation/context'

/**
 * Full-screen QR scanner overlay. Reads the host's join QR and hands back the raw railreel://
 * link. Non-RailReel codes are ignored so a stray QR can't hijack the flow. See JoinSessionScreen.
 */
export function QrScanner({ onScan, onClose }: { onScan: (data: string) => void; onClose: () => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  // Keep the reticle (and the text under it) on-screen in landscape / split-screen.
  const reticleSize = Math.max(140, Math.min(240, Math.floor(Math.min(width, height) * 0.55)))
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
      <View style={styles.overlay}>
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
      </View>

      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close scanner"
        style={[
          styles.close,
          // Clear the status bar / cutout / gesture bar in any orientation.
          { top: insets.top + 12, right: insets.right + 16, borderColor: t.palette.hairline, backgroundColor: t.palette.raised },
        ]}
      >
        <X size={22} color={t.palette.textSecondary} strokeWidth={2.25} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, zIndex: 10 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingHorizontal: 32 },
  reticle: { width: 240, height: 240, borderWidth: 2, borderRadius: radii.xl },
  caption: { textAlign: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: radii.md, overflow: 'hidden' },
  close: {
    position: 'absolute',
    width: sizes.touch,
    height: sizes.touch,
    borderRadius: sizes.touch / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
