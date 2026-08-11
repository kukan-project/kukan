import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      // Brand resolves to the default brand for tests; must precede '@' so
      // '@/brand/*' is not swallowed by the general '@' → src mapping (ADR-042).
      '@/brand': resolve(import.meta.dirname, 'brands/default'),
      '@': resolve(import.meta.dirname, 'src'),
      '@kukan/ui': resolve(import.meta.dirname, '../../packages/ui/src'),
      '@kukan/shared': resolve(import.meta.dirname, '../../packages/shared/src'),
    },
  },
})
