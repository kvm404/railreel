import { useRef, useState } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { X } from 'lucide-react-native'
import { Button, Text } from '@/ui'
import { useTheme } from '@/theme/ThemeProvider'
import { decodeJoinUrl } from '@/lib/protocol'

/**
 * Full-screen QR scanner overlay. Reads the host's join QR and hands back the raw railreel://
 * link. Non-RailReel codes are ignored so a stray QR can't hijack the flow. See JoinSessionScreen.
 */
export function QrScanner({ onScan, onClose }: { onScan: (data: string) => void; onClose: () => void }) {
  const t = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [hint, setHint] = useState(false)
  const handled = useRef(false)

  const onBarcode = ({ data }: { data: string }) => {
    if (handled.current) return
    // Validate exactly like the paste/deep-link path so a malformed code is rejected here, not later.
    try {
      decodeJoinUrl(data.trim())
    } catch {
      setHint(true) // a QR, but not a valid RailReel join code
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
        {granted ? <View style={[styles.reticle, { borderColor: t.palette.amber }]} /> : null}
        <Text variant="data" tone="secondary" style={styles.caption}>
          {granted
            ? hint
              ? 'That’s not a RailReel code — point at the host’s QR'
              : 'Point at the host’s QR code'
            : blocked
              ? 'Camera access is off. Enable it in Settings to scan.'
              : 'Camera access is needed to scan the host’s code'}
        </Text>
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
        style={[styles.close, { borderColor: t.palette.hairline, backgroundColor: t.palette.raised }]}
      >
        <X size={22} color={t.palette.textSecondary} strokeWidth={2.25} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, zIndex: 10 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingHorizontal: 32 },
  reticle: { width: 240, height: 240, borderWidth: 2, borderRadius: 28 },
  caption: { textAlign: 'center' },
  close: {
    position: 'absolute',
    top: 56,
    right: 24,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
