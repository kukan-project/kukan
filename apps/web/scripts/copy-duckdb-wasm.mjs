/* global console */
/**
 * Copy DuckDB-WASM binaries and worker files to public/duckdb/
 * for static serving. Run via dev/build scripts.
 */

import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dest = join(__dirname, '..', 'public', 'duckdb')

// Resolve through pnpm's symlink structure
const require = createRequire(join(__dirname, '..', 'package.json'))
const entryPath = require.resolve('@duckdb/duckdb-wasm')
// Entry resolves to dist/duckdb-browser.cjs — go up to dist/
const src = dirname(entryPath)

const files = [
  'duckdb-mvp.wasm',
  'duckdb-eh.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-browser-eh.worker.js',
]

mkdirSync(dest, { recursive: true })

for (const file of files) {
  cpSync(join(src, file), join(dest, file))
}

console.log(`Copied DuckDB-WASM files to ${dest}`)
