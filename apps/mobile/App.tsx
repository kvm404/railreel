import { useCallback } from 'react'
import { View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeProvider } from '@/theme/ThemeProvider'
import { SessionProvider } from '@/session/SessionProvider'
import { useAppFonts } from '@/theme/fonts'
import { Navigator, type Routes } from '@/navigation/Navigator'
import { HomeScreen } from '@/screens/HomeScreen'
import { CreateSessionScreen } from '@/screens/CreateSessionScreen'
import { JoinSessionScreen } from '@/screens/JoinSessionScreen'
import { LobbyScreen } from '@/screens/LobbyScreen'
import { PlayerScreen } from '@/screens/PlayerScreen'
import { AboutScreen } from '@/screens/AboutScreen'
import { InviteLinkProvider, withInviteBridge } from '@/hooks/inviteLinks'
import { palette } from '@/theme/tokens'

// Keep the native splash up until fonts are ready (no flash of fallback type).
SplashScreen.preventAutoHideAsync().catch(() => {})

// Each route hosts the invite bridge: a tapped railreel:// invite opens Join (name only) from Home
// or an unstarted Create, and is dropped while a session is live (see hooks/inviteLinks).
const routes: Routes = {
  Home: withInviteBridge('Home', HomeScreen),
  CreateSession: withInviteBridge('CreateSession', CreateSessionScreen),
  JoinSession: JoinSessionScreen,
  Lobby: withInviteBridge('Lobby', LobbyScreen),
  Player: withInviteBridge('Player', PlayerScreen),
  About: withInviteBridge('About', AboutScreen),
}

export default function App() {
  const fontsReady = useAppFonts()

  const onLayout = useCallback(() => {
    if (fontsReady) SplashScreen.hideAsync().catch(() => {})
  }, [fontsReady])

  if (!fontsReady) return null

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayout}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SessionProvider>
            <InviteLinkProvider>
              <View style={{ flex: 1, backgroundColor: palette.base }}>
                <StatusBar style="light" />
                <Navigator routes={routes} initial="Home" />
              </View>
            </InviteLinkProvider>
          </SessionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
