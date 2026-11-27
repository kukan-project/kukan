/* global console, fetch, Buffer, AbortSignal */
/**
 * Put the DuckDB-WASM extensions the browser loads under
 * public/vendor/duckdb-extensions/<duckdb version>/<platform>/, where
 * `custom_extension_repository` points it (hooks/use-duckdb.ts). Left to
 * itself DuckDB-WASM fetches them from extensions.duckdb.org on first use:
 * outside the pages' CSP, out of reach on a closed network, and a third party
 * every visitor's browser would contact.
 *
 * The ones a query reaches: `parquet` (the preview), `json` (the settled
 * estimate's sample) and `icu` (its timestamps, `AT TIME ZONE`). Each is fetched into vendor/duckdb-extensions/
 * (gitignored) unless it is already there, as on a closed network, and checked
 * against the SHA-256 in manifest.json before it is served. The version has to
 * be the DuckDB inside @duckdb/duckdb-wasm, which refuses an extension built
 * for another (settled-parity.test.ts checks the two agree). Run via the
 * dev/build scripts.
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(webRoot, 'vendor', 'duckdb-extensions')
const { duckdb, platform, extensions } = JSON.parse(
  readFileSync(join(srcDir, 'manifest.json'), 'utf8')
)
const cacheDir = join(srcDir, duckdb, platform)
const vendorDir = join(webRoot, 'public', 'vendor', 'duckdb-extensions')
const dest = join(vendorDir, duckdb, platform)

/** One download, body included: a stalled connection has no limit of its own and would hold the image build. */
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000

async function download(url, path) {
  console.log(`Fetching ${url}`)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    throw new Error(
      `Could not fetch ${url}. Where the build cannot reach it, put the file at ${path}`,
      {
        cause,
      }
    )
  }
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
mkdirSync(cacheDir, { recursive: true })
for (const [name, sha256] of Object.entries(extensions)) {
  const file = `${name}.duckdb_extension.wasm`
  const path = join(cacheDir, file)
  const present = existsSync(path)
  const bytes = present
    ? readFileSync(path)
    : await download(`https://extensions.duckdb.org/${duckdb}/${platform}/${file}`, path)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== sha256) {
    throw new Error(
      `${file} for DuckDB ${duckdb} has SHA-256 ${actual}, not the ${sha256} in manifest.json` +
        (present ? `: replace ${path}` : '')
    )
  }
  if (!present) writeFileSync(path, bytes)
  cpSync(path, join(dest, file))
}
// An upgrade's leftovers
for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== duckdb) {
    rmSync(join(srcDir, entry.name), { recursive: true, force: true })
  }
}

console.log(`Put DuckDB ${duckdb} extensions (${Object.keys(extensions).join(', ')}) in ${dest}`)
