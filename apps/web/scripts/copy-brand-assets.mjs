/* global console, process */
/**
 * Materialize the active brand's public assets into public/brand/ (ADR-042).
 * The active brand is KUKAN_BRAND (unset → 'default'), resolved uniformly to
 * brands/<brand>/public. public/brand/ is a generated directory (gitignored)
 * served at /brand/... — reset it each run so a previously built brand's assets
 * never linger. Run via the dev/build scripts.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const brand = process.env.KUKAN_BRAND || 'default'

const brandRoot = join(webRoot, 'brands', brand)
if (!existsSync(brandRoot)) {
  throw new Error(
    `KUKAN_BRAND="${brand}" but apps/web/brands/${brand}/ does not exist — ` +
      'add the brand directory or unset KUKAN_BRAND for the default brand (ADR-042)'
  )
}

const src = join(brandRoot, 'public')
const dest = join(webRoot, 'public', 'brand')

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
if (existsSync(src)) {
  // Skip .gitkeep — it only keeps the source dir tracked; dest is gitignored.
  cpSync(src, dest, { recursive: true, filter: (s) => !s.endsWith('.gitkeep') })
}

console.log(`Copied ${brand ?? 'default'} brand assets to ${dest}`)
