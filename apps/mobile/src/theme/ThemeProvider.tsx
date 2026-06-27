import { createContext, useContext, type ReactNode } from 'react'
import { tokens, type Tokens } from './tokens'

const ThemeContext = createContext<Tokens>(tokens)

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Single dark theme for now; this is where light/alt themes would branch later.
  return <ThemeContext.Provider value={tokens}>{children}</ThemeContext.Provider>
}

export function useTheme(): Tokens {
  return useContext(ThemeContext)
}
