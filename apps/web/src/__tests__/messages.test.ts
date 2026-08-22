/**
 * The two locales have to describe the same screens.
 *
 * The unit tests resolve every message against `en.json` (see `setup.ts`), so a
 * key added to one file and not the other passes everything and then fails in
 * the browser — as a raw key path for a missing leaf, and as a thrown
 * `MISSING_MESSAGE` for a whole missing namespace, which takes the page with
 * it. Nothing else compares them.
 */
import { describe, it, expect } from 'vitest'
import en from '../../messages/en.json'
import ja from '../../messages/ja.json'

type Tree = { [key: string]: string | Tree }

/** Every leaf's dotted path, so a mismatch names the key rather than a diff. */
function paths(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [path] : paths(value, path)
  })
}

/** The `{name}` placeholders a message expects, which have to match too. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort()
}

/**
 * `license.*` is deliberately one-sided: `resolveLicenseLabel` asks `t.has()`
 * and falls back to the licence's own English title, so English carries only
 * the ones whose canonical title is not already the label.
 */
const ONE_SIDED = /^license\./

function leaf(tree: Tree, path: string): string {
  return path.split('.').reduce<string | Tree>((node, key) => (node as Tree)[key], tree) as string
}

describe('messages', () => {
  const enPaths = paths(en as Tree).filter((p) => !ONE_SIDED.test(p))
  const jaPaths = paths(ja as Tree).filter((p) => !ONE_SIDED.test(p))

  it('has the same keys in both locales', () => {
    expect(jaPaths.filter((p) => !enPaths.includes(p))).toEqual([])
    expect(enPaths.filter((p) => !jaPaths.includes(p))).toEqual([])
  })

  it('takes the same arguments in both locales', () => {
    // A translation that drops `{version}` renders a sentence missing the thing
    // it was about; one that invents a placeholder throws at format time.
    const mismatched = enPaths
      .filter((p) => jaPaths.includes(p))
      .filter(
        (p) => placeholders(leaf(en as Tree, p)).join() !== placeholders(leaf(ja as Tree, p)).join()
      )
    expect(mismatched).toEqual([])
  })
})
