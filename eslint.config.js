import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
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
    // Lambda handlers: console IS the CloudWatch log sink
    files: ['**/scripts/**', '**/migrate.ts', '**/__tests__/**', 'infra/lib/lambda/**'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist', 'node_modules', '.turbo', 'drizzle'],
  }
)
