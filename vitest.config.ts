import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { availableParallelism } from 'node:os'
import { resolve } from 'path'

/**
 * How many integration files run at once.
 *
 * Capped for two reasons, both measured. Each fork holds a pool against its own
 * database, so the count is also a connection budget: uncapped on a 24-core box
 * that was 23 forks a run, and two runs at once hit the server's ceiling and
 * both failed with `sorry, too many clients already` — surfacing as unrelated
 * assertion failures. And more forks was not even faster: 23 ran the API suite
 * in 41.9s against 37.2s at eight, burning 187s of aggregate CPU against 148s,
 * because every fork also drives a Postgres backend.
 */
const INTEGRATION_FORKS = Math.min(Math.max(availableParallelism() - 1, 1), 8)

/**
 * A group of their own, since `maxWorkers` belongs to the group: sharing one
 * with the uncapped unit projects refuses to start. Both in it rather than one
 * each, so the two suites share the budget instead of taking it apiece.
 */
const INTEGRATION_GROUP = 1

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
          name: 'infra',
          root: './infra',
          include: ['lib/**/__tests__/**/*.test.ts'],
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
          name: 'lake',
          root: './packages/lake',
          include: ['src/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'worker',
          root: './apps/worker',
          include: ['src/__tests__/**/*.test.ts'],
          exclude: ['src/__tests__/**/*.integration.test.ts'],
          environment: 'node',
        },
        resolve: {
          alias: {
            '@': resolve(__dirname, 'apps/worker/src'),
          },
        },
      },
      {
        // The worker's raw SQL — the step tracker's parking CTEs, the orphan
        // sweep's reference check — against a real Postgres, in a database of
        // its own so it and the API's suites cannot truncate each other's rows.
        test: {
          name: 'worker-integration',
          root: './apps/worker',
          include: ['src/__tests__/**/*.integration.test.ts'],
          environment: 'node',
          globalSetup: ['src/__tests__/test-helpers/global-setup.ts'],
          setupFiles: ['src/__tests__/test-helpers/setup-integration.ts'],
          pool: 'forks',
          maxWorkers: INTEGRATION_FORKS,
          sequence: { groupOrder: INTEGRATION_GROUP },
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
          setupFiles: ['src/__tests__/test-helpers/setup-integration.ts'],
          pool: 'forks',
          maxWorkers: INTEGRATION_FORKS,
          sequence: { groupOrder: INTEGRATION_GROUP },
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
            // Brand resolves to the default brand; must precede '@' so '@/brand/*'
            // is not swallowed by the general '@' → src mapping (ADR-042).
            '@/brand': resolve(__dirname, 'apps/web/brands/default'),
            '@': resolve(__dirname, 'apps/web/src'),
            '@kukan/ui': resolve(__dirname, 'packages/ui/src'),
            '@kukan/shared': resolve(__dirname, 'packages/shared/src'),
          },
        },
      },
    ],
  },
})
