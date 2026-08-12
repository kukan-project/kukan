import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import { noRawSubqueryInProjection } from './eslint-rules/no-raw-subquery-in-projection.js'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { kukan: { rules: { 'no-raw-subquery-in-projection': noRawSubqueryInProjection } } },
    rules: {
      'kukan/no-raw-subquery-in-projection': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // The wrapper adds the Problem Details shaping the raw validator lacks (#285)
    files: ['packages/api/src/routes/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hono/zod-validator',
              message: "Import zValidator from '../middleware/validator' instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // Things a person or a log sink reads directly, rather than a service's
    // structured output: Lambda handlers, where console IS the CloudWatch sink,
    // and operator entry points, where the point is legible stdout. The
    // reconciliation is named by its full path so the module it drives — same
    // basename, under `cron/` — stays held to the rule.
    files: [
      '**/scripts/**',
      '**/migrate.ts',
      '**/__tests__/**',
      'infra/lib/lambda/**',
      'apps/worker/src/reconcile-orphans.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist', 'node_modules', '.turbo', 'drizzle'],
  }
)
