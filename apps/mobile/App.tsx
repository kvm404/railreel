import { View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider } from '@/theme/ThemeProvider'
import { useAppFonts } from '@/theme/fonts'
import { HomeScreen } from '@/screens/HomeScreen'
import { palette } from '@/theme/tokens'

export default function App() {
  const fontsReady = useAppFonts()

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <StatusBar style="light" />
          {fontsReady ? (
            <HomeScreen />
          ) : (
            // Hold on the night canvas until type is ready — no flash of fallback fonts.
            <View style={{ flex: 1, backgroundColor: palette.base }} />
          )}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
