import { defineConfig } from 'tsup'

export default defineConfig({
  // The reconciliation is a second entry rather than a `scripts/` file: the
  // image carries `dist` and production dependencies only, so a script there
  // would have neither a copy in the container nor a `tsx` to run it (ADR-045
  // open issue 1). It is the container that can reach the real bucket.
  entry: ['src/index.ts', 'src/reconcile-orphans.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  // Bundle workspace packages to resolve ESM extensionless imports
  noExternal: [/^@kukan\//],
  // pino uses dynamic require() for Node built-ins — must stay external
  // croner uses Node.js timer APIs — keep external to avoid bundling issues
  // @opensearch-project/opensearch uses CommonJS require('events') etc.
  // @duckdb/node-api (via @kukan/lake) loads a platform-specific .node binding
  // at runtime; bundling it makes esbuild resolve every platform's binary.
  external: ['pino', 'pino-pretty', 'croner', '@opensearch-project/opensearch', /^@duckdb\/node-/],
  splitting: false,
  clean: true,
  sourcemap: true,
})
