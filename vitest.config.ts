import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/cdk.out/**', '**/dist/**', '**/.next/**', '**/site/**'],
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'adapter-search',
          root: './packages/adapters/search',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'adapter-queue',
          root: './packages/adapters/queue',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'adapter-ai',
          root: './packages/adapters/ai',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'adapter-storage',
          root: './packages/adapters/storage',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'worker',
          root: './apps/worker',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
        resolve: {
          alias: {
            '@': resolve(__dirname, 'apps/worker/src'),
          },
        },
      },
      {
        test: {
          name: 'api-unit',
          root: './packages/api',
          include: ['src/__tests__/**/*.test.ts'],
          exclude: ['src/__tests__/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'api-integration',
          root: './packages/api',
          include: ['src/__tests__/**/*.integration.test.ts'],
          environment: 'node',
          globalSetup: ['src/__tests__/test-helpers/global-setup.ts'],
          pool: 'forks',
          fileParallelism: false,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/__tests__/setup.ts'],
          include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
        },
        resolve: {
          alias: {
            '@': resolve(__dirname, 'apps/web/src'),
            '@kukan/ui': resolve(__dirname, 'packages/ui/src'),
            '@kukan/shared': resolve(__dirname, 'packages/shared/src'),
          },
        },
      },
    ],
  },
})
