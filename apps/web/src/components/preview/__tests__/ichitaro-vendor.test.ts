import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '../../../../public/vendor/ezpzjtd')

describe('the vendored EZPZ File JTD', () => {
  it('is what its build recorded', () => {
    for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [sum, name] = line.split(/\s+/) as [string, string]
      const actual = createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex')
      expect(`${name} ${actual}`).toBe(`${name} ${sum}`)
    }
  })

  // Its safety rests on this: with these alone, a document that took it over
  // reaches nothing, neither the network nor KUKAN's API. A new version that
  // wants more needs a look at what it can then reach (ADR-051 decision 7)
  it('imports nothing but what raises an error', async () => {
    const wasm = readFileSync(join(dir, 'ezpzjtd_viewer_bg.wasm'))
    const imports = WebAssembly.Module.imports(await WebAssembly.compile(wasm))
    expect(imports.map(({ name }) => name.replace(/_[0-9a-f]{16}$/, ''))).toEqual([
      '__wbg_Error',
      '__wbg___wbindgen_throw',
      '__wbindgen_init_externref_table',
    ])
  })
})
