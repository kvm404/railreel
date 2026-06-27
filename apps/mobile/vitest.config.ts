import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Unit tests run in Node against the PURE logic in src/lib (no React Native imports).
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
  },
})
