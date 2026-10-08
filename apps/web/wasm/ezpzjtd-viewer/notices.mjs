// Writes into the directory given what the build must carry: EZPZ File JTD's
// LICENSE and NOTICE, the commit it is built from (SOURCE), and
// THIRD_PARTY_NOTICES — the licence of each crate compiled into the .wasm,
// as `cargo metadata` resolves them. Procedural macros run at build time and
// are not in it.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const out = process.argv[2]
const meta = JSON.parse(
  execFileSync(
    'cargo',
    [
      '+1.90.0',
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--filter-platform',
      'wasm32-unknown-unknown',
    ],
    { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
)
const packages = new Map(meta.packages.map((p) => [p.id, p]))
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
const isMacro = (p) => p.targets.some((t) => t.kind.includes('proc-macro'))

const linked = new Set()
const pending = [meta.resolve.root]
while (pending.length > 0) {
  const id = pending.pop()
  if (linked.has(id) || isMacro(packages.get(id))) continue
  linked.add(id)
  for (const dep of nodes.get(id).deps) {
    if (dep.dep_kinds.some((k) => k.kind === null)) pending.push(dep.pkg)
  }
}

const core = [...linked].map((id) => packages.get(id)).find((p) => p.name === 'ezpzjtd-core')
// The crate is at engine/crates/ezpzjtd-core of its repository
const ezpzRoot = join(dirname(core.manifest_path), '../../..')
for (const name of ['LICENSE', 'NOTICE']) {
  writeFileSync(join(out, name), readFileSync(join(ezpzRoot, name)))
}
writeFileSync(join(out, 'SOURCE'), `${core.source.replace(/^git\+/, '')}\n`)

const crates = [...linked]
  .map((id) => packages.get(id))
  .filter((p) => p.source?.startsWith('registry+'))
  .sort((a, b) => a.name.localeCompare(b.name))
const lines = [
  'Crates compiled into ezpzjtd_viewer_bg.wasm besides EZPZ File JTD (see LICENSE and NOTICE).',
  'Where a crate is dual-licensed, it is used here under the MIT License.',
  '',
]
for (const p of crates) {
  lines.push('='.repeat(72), `${p.name} ${p.version} — ${p.license}`, '='.repeat(72), '')
  for (const file of ['COPYRIGHT', 'LICENSE-MIT', 'LICENSE-WHATWG', 'LICENSE-UNICODE']) {
    const path = join(dirname(p.manifest_path), file)
    if (existsSync(path)) lines.push(readFileSync(path, 'utf8').trimEnd(), '')
  }
}
writeFileSync(join(out, 'THIRD_PARTY_NOTICES'), lines.join('\n'))
