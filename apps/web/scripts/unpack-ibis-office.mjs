/* global console, fetch, Buffer, AbortSignal */
/**
 * Unpack the ibisOffice web build into public/vendor/ibis-office/<version>/
 * (ADR-065 decision 1). The archive is upstream's release asset, fetched into
 * vendor/ibis-office/ (gitignored) unless it is already there, as on a closed
 * network, and checked against the SHA-256 in manifest.json before anything is
 * written. Only the app's pkg/, assets/ and license.md are unpacked: the
 * playground's index.html and main.js would open any `?open=` URL on this
 * origin, outside the sandbox. LICENSE, NOTICE and SOURCE, which the archive
 * does not hold, and KUKAN's boot page (boot/, decision 2) go beside them.
 * public/vendor/ibis-office/ is a generated directory (gitignored), reset on
 * each run. Run via the dev/build scripts.
 */

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

const SERVED = ['pkg/', 'assets/', 'license.md']

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(webRoot, 'vendor', 'ibis-office')
const { version, sha256 } = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8'))
const archiveName = `ibisOffice-${version}-Web.zip`
const archivePath = join(srcDir, archiveName)
const vendorDir = join(webRoot, 'public', 'vendor', 'ibis-office')
const dest = join(vendorDir, version)

/** The whole download, body included: a stalled connection has no limit of its own and would hold the image build. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

async function download() {
  const url = `https://github.com/ibisjp/ibis-office/releases/download/v${version}/${archiveName}`
  console.log(`Fetching ${url}`)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    throw new Error(
      `Could not fetch ${url}. Where the build cannot reach it, put the file at ${archivePath}`,
      { cause }
    )
  }
}

function unpack(archive) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError)
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry) => {
        const { fileName } = entry
        if (fileName.endsWith('/') || !SERVED.some((served) => fileName.startsWith(served))) {
          return zip.readEntry()
        }
        // Inside `dest`: yauzl refuses an absolute name or one with a `..` segment before emitting it
        const target = join(dest, fileName)
        mkdirSync(dirname(target), { recursive: true })
        zip.openReadStream(entry, (readError, stream) => {
          if (readError) return reject(readError)
          pipeline(stream, createWriteStream(target)).then(() => zip.readEntry(), reject)
        })
      })
      zip.readEntry()
    })
  })
}

const present = existsSync(archivePath)
const archive = present ? readFileSync(archivePath) : await download()
const actual = createHash('sha256').update(archive).digest('hex')
if (actual !== sha256) {
  throw new Error(
    `${archiveName} has SHA-256 ${actual}, not the ${sha256} in manifest.json` +
      (present ? `: replace ${archivePath}` : '')
  )
}
if (!present) writeFileSync(archivePath, archive)
// An upgrade's leftovers
for (const name of readdirSync(srcDir)) {
  if (name.endsWith('-Web.zip') && name !== archiveName) rmSync(join(srcDir, name))
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
await unpack(archive)
for (const name of ['LICENSE', 'NOTICE', 'SOURCE']) {
  cpSync(join(srcDir, name), join(dest, name))
}
cpSync(join(srcDir, 'boot'), dest, { recursive: true })

console.log(`Unpacked ibisOffice ${version} to ${dest}`)
