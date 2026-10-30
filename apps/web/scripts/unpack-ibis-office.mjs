/* global console */
/**
 * Unpack the vendored ibisOffice web build into public/vendor/ibis-office/<version>/
 * (ADR-065 decision 1). The archive under vendor/ibis-office/ holds upstream's
 * LICENSE and NOTICE and the playground build's app/ directory, unmodified, and is
 * checked against its SHA-256 before anything is written. Only the app's pkg/,
 * assets/ and license.md are unpacked: the playground's index.html and main.js
 * would open any `?open=` URL on this origin, outside the sandbox. SOURCE comes
 * from vendor/ibis-office/. public/vendor/ibis-office/ is a generated directory
 * (gitignored), reset on each run. Run via the dev/build scripts.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.8.4'
const ARCHIVE_SHA256 = '712b0631d355530a1e5b4766f1beeea32f5d8921b9af9601147181ca5a9605aa'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(webRoot, 'vendor', 'ibis-office')
const archiveName = `ibis-office-web-${VERSION}.tar.gz`
const vendorDir = join(webRoot, 'public', 'vendor', 'ibis-office')
const dest = join(vendorDir, VERSION)

const sha256 = createHash('sha256')
  .update(readFileSync(join(srcDir, archiveName)))
  .digest('hex')
if (sha256 !== ARCHIVE_SHA256) {
  throw new Error(
    `apps/web/vendor/ibis-office/${archiveName} has SHA-256 ${sha256}, not ${ARCHIVE_SHA256}: ` +
      'the archive is not the one this script was written for (ADR-065)'
  )
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
// A relative archive name: Git Bash's GNU tar reads `C:\...` as a remote host.
const tar = (...args) =>
  execFileSync('tar', ['-xzf', archiveName, '-C', dest, ...args], { cwd: srcDir })
tar('--strip-components=1', 'app/pkg', 'app/assets', 'app/license.md')
tar('LICENSE', 'NOTICE')
cpSync(join(srcDir, 'SOURCE'), join(dest, 'SOURCE'))

console.log(`Unpacked ibisOffice ${VERSION} to ${dest}`)
