#!/usr/bin/env node
/**
 * Fails when a version-selector override in package.json
 * (`"name@<range>": "<replacement>"`) no longer does anything: no dependent of
 * `name` — the workspace's own packages and everything installed — declares a
 * range that reaches `<range>` but not `<replacement>`. Such an override forces
 * a version past what upstream allowed, so once upstream allows it, the
 * override is to be removed rather than left to pin the version on its own.
 *
 * `pnpm why` names the dependents, so it runs after install. Their declared
 * ranges come from their manifests, which pnpm does not report. A dependent
 * that bundles the package is left out, since an override cannot reach a
 * bundled copy.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import console from 'node:console'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = fileURLToPath(import.meta.resolve('../'))
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const pnpm = (...args) => JSON.parse(execFileSync('pnpm', args, { cwd: root, encoding: 'utf8' }))

const selectors = []
const overrides = readJson(join(root, 'package.json')).pnpm?.overrides ?? {}
for (const [key, replacement] of Object.entries(overrides)) {
  const at = key.indexOf('@', 1)
  // A parent selector has `>` before a package name; `>` in a range is before a version
  if (at < 0 || /\S>[@a-z]/i.test(key) || !semver.validRange(replacement))
    console.log(`${key}: not checked`)
  else selectors.push({ key, name: key.slice(0, at), replaced: key.slice(at + 1), replacement })
}

const workspace = new Map(pnpm('ls', '-r', '--depth', '-1', '--json').map((p) => [p.name, p.path]))

/** Installed packages' directories by `name@version`; a store directory adds `_` and its peers. */
const store = join(root, 'node_modules/.pnpm')
const installed = new Map()
for (const dir of readdirSync(store)) {
  const at = dir.indexOf('@', 1)
  if (at < 0) continue
  const name = dir.slice(0, at).replace('+', '/')
  const version = dir.slice(at + 1).split('_')[0]
  installed.set(`${name}@${version}`, join(store, dir, 'node_modules', name))
}

/** Every dependent of `name` with the range it declares, bundled copies left out. */
function dependents(name) {
  const ranges = new Map()
  for (const { dependents: list = [] } of pnpm('why', name, '-r', '--json', '--depth', '0')) {
    for (const { name: who, version, depField } of list) {
      const dir = depField ? workspace.get(who) : installed.get(`${who}@${version}`)
      if (!dir) throw new Error(`No directory found for ${who}@${version}`)
      const manifest = readJson(join(dir, 'package.json'))
      const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies ?? []
      if (bundled === true || bundled.includes(name)) continue
      const range = (
        depField
          ? (manifest[depField] ?? {})
          : {
              ...manifest.peerDependencies,
              ...manifest.optionalDependencies,
              ...manifest.dependencies,
            }
      )[name]
      if (range) ranges.set(`${who}@${version}`, range)
    }
  }
  return [...ranges]
}

let stale = 0
for (const { key, name, replaced, replacement } of selectors) {
  const ranges = dependents(name)
  // Still needed while some dependent could resolve to a replaced version and
  // never to the replacement: without the override it would stay where it was
  const holding = ranges.filter(
    ([, range]) =>
      semver.validRange(range) &&
      semver.intersects(range, replaced) &&
      !semver.intersects(range, replacement)
  )
  if (holding.length) {
    console.log(`${key}: still needed by ${holding.map(([who]) => who).join(', ')}`)
  } else {
    stale++
    console.error(
      `${key}: every dependent reaching ${replaced} now admits ${replacement} ` +
        `(${ranges.map(([who, range]) => `${who} → ${range}`).join(', ') || 'no dependents'}). ` +
        'Remove the override from package.json.'
    )
  }
}
process.exit(stale ? 1 : 0)
