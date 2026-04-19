import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  // Bundle workspace packages to resolve ESM extensionless imports
  noExternal: [/^@kukan\//],
  // pino uses dynamic require() for Node built-ins — must stay external
  // croner uses Node.js timer APIs — keep external to avoid bundling issues
  // @opensearch-project/opensearch uses CommonJS require('events') etc.
  external: ['pino', 'pino-pretty', 'croner', '@opensearch-project/opensearch'],
  splitting: false,
  clean: true,
  sourcemap: true,
})
