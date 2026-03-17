import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
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
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    extends: './apps/web/vitest.config.ts',
    test: {
      name: 'web',
      root: './apps/web',
    },
  },
])
