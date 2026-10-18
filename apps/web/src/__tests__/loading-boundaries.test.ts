/**
 * No `loading.tsx` may sit above a page that calls `notFound()`.
 *
 * A loading boundary makes Next stream the response before the page renders,
 * so the status is already 200 when `notFound()` runs: a missing dataset or
 * organization answers a soft 404 (the not-found screen with a 200). Nothing
 * else fails when one is added — the page still looks right in the browser.
 * Keep a skeleton to its page with a route group (`(list)`, `(home)`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describe, it, expect } from 'vitest'

const APP_DIR = join(__dirname, '../app')

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => !f.split(sep).includes('__tests__'))
    .map((f) => join(dir, f))
}

describe('loading boundaries', () => {
  const files = filesUnder(APP_DIR)
  const boundaries = files.filter((f) => f.endsWith(`${sep}loading.tsx`))

  it('finds the boundaries it guards', () => {
    expect(boundaries.length).toBeGreaterThan(0)
  })

  it.each(boundaries.map((f) => [relative(APP_DIR, f)]))(
    '%s wraps no page that calls notFound()',
    (boundary) => {
      const dir = dirname(join(APP_DIR, boundary))
      const offending = files
        .filter((f) => f.startsWith(dir + sep) && f.endsWith(`${sep}page.tsx`))
        .filter((f) => readFileSync(f, 'utf8').includes('notFound('))
        .map((f) => relative(APP_DIR, f))
      expect(offending).toEqual([])
    }
  )
})
