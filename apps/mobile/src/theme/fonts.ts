import { useFonts } from 'expo-font'
import { Unbounded_600SemiBold, Unbounded_700Bold } from '@expo-google-fonts/unbounded'
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk'
import { SpaceMono_400Regular, SpaceMono_700Bold } from '@expo-google-fonts/space-mono'

/**
 * Loads the RailReel typefaces. Keys must match the family names in tokens.ts `fonts`.
 * Returns true once fonts are ready (or failed) so the app can drop the splash.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts({
    Unbounded_600SemiBold,
    Unbounded_700Bold,
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    SpaceMono_400Regular,
    SpaceMono_700Bold,
  })
  if (error) {
    // Don't block the app on a font failure, but make it visible.
    console.warn('[RailReel] font load failed, falling back to system fonts:', error)
  }
  return loaded || error !== null
}
