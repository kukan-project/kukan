/**
 * What the worker calls itself on every request it makes to someone else's
 * server: `KUKAN/<version>`, and `(+<site>)` when one is configured.
 *
 * undici's default, `undici`, names a library and nothing else — an operator
 * seeing it cannot tell what the traffic is for, reach whoever runs it, or put
 * it on an allowlist, and the only answer left to them is a block. The site URL
 * is the way back to whoever runs this catalog. One product token for the link
 * check and the pipeline alike, so a `robots.txt` group has one name to use.
 */
import { readFileSync } from 'node:fs'
import type { Env } from '@kukan/shared'

/**
 * The release, from the repository's package.json — three levels up from both
 * `src/` in development and `dist/` in the image, which copies it for this.
 */
function releaseVersion(): string | null {
  try {
    const url = new URL('../../../package.json', import.meta.url)
    const { version } = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown }
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

export function buildUserAgent(
  env: Pick<Env, 'USER_AGENT_URL'>,
  version: string | null = releaseVersion()
): string {
  const site = env.USER_AGENT_URL?.replace(/\/+$/, '')
  return `KUKAN${version ? `/${version}` : ''}${site ? ` (+${site})` : ''}`
}
