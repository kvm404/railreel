import { useCallback } from 'react'
import { View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider } from '@/theme/ThemeProvider'
import { useAppFonts } from '@/theme/fonts'
import { HomeScreen } from '@/screens/HomeScreen'
import { palette } from '@/theme/tokens'

// Keep the native splash up until fonts are ready (no flash of fallback type).
SplashScreen.preventAutoHideAsync().catch(() => {})

export default function App() {
  const fontsReady = useAppFonts()

  // Hand off from the native splash to our canvas once the first frame can paint.
  const onLayout = useCallback(() => {
    if (fontsReady) SplashScreen.hideAsync().catch(() => {})
  }, [fontsReady])

  if (!fontsReady) return null

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayout}>
      <SafeAreaProvider>
        <ThemeProvider>
          <View style={{ flex: 1, backgroundColor: palette.base }}>
            <StatusBar style="light" />
            <HomeScreen />
          </View>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
