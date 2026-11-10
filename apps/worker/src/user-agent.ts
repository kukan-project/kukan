/**
 * What the worker calls itself on every request it makes to someone else's
 * server: `KUKAN`, and `(+<site>)` when one is configured.
 *
 * undici's default, `undici`, names a library and nothing else — an operator
 * seeing it cannot tell what the traffic is for, reach whoever runs it, or put
 * it on an allowlist, and the only answer left to them is a block. The site URL
 * is the way back to whoever runs this catalog. One product token for the link
 * check and the pipeline alike, so a `robots.txt` group has one name to use.
 *
 * No release: anyone who can register a resource URL can have the worker fetch
 * from a server of theirs, and with the site named that reads as which site is
 * behind on patches (ADR-070).
 */
import { trimTrailing, type Env } from '@kukan/shared'

export function buildUserAgent(env: Pick<Env, 'USER_AGENT_URL'>): string {
  const site = env.USER_AGENT_URL && trimTrailing(env.USER_AGENT_URL, '/')
  return `KUKAN${site ? ` (+${site})` : ''}`
}
