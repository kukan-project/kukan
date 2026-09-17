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
import { PACKAGE_NAME_PATTERN } from '@kukan/shared'
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

/**
 * The messages that describe the slug name rule, and the words each locale has
 * to use to describe it.
 *
 * The Japanese `auth.nameError` once read 半角英数字、ハイフン、アンダースコア,
 * which `Taro-Yamada` satisfies — so the one rule it broke, lowercase, went
 * unsaid and the rejection read as a bug rather than a spec. Both locales had
 * also left out the period the pattern allows. Neither shows up in a key or
 * placeholder comparison, which is why this reads the prose.
 */
const SLUG_RULE_PATHS = ['common.nameHelp', 'auth.nameError']

const MUST_NAME = {
  en: [/lowercase/i, /period/i],
  ja: [/小文字/, /ピリオド/],
} as const

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

  it('names every constraint of the slug rule, in both locales', () => {
    const silent = SLUG_RULE_PATHS.flatMap((path) =>
      (['en', 'ja'] as const).flatMap((locale) => {
        const message = leaf((locale === 'en' ? en : ja) as Tree, path)
        return MUST_NAME[locale]
          .filter((word) => !word.test(message))
          .map((word) => `${locale} ${path} says nothing about ${word.source}: ${message}`)
      })
    )
    expect(silent).toEqual([])
  })

  // What the words above are pinned to. Relax the pattern and this fails first,
  // pointing at the messages that would otherwise go on describing the old rule.
  it('describes a pattern that still rejects capitals and allows periods', () => {
    expect(PACKAGE_NAME_PATTERN.test('taro.yamada')).toBe(true)
    expect(PACKAGE_NAME_PATTERN.test('Taro-Yamada')).toBe(false)
  })
})
