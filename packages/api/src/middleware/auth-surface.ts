/**
 * Blocks the Better Auth endpoints KUKAN does not offer.
 *
 * Answers 404 rather than 403 so the surface is not advertised.
 */

import type { MiddlewareHandler } from 'hono'
import { KukanError } from '@kukan/shared'

/** Paths under /api/auth that the auth handler must never see, and why.
 *
 *  - admin/*: the admin plugin's HTTP endpoints (impersonate-user, ban-user,
 *    set-role, set-user-password, list-users, remove-user, ...). KUKAN manages
 *    users, roles, and account lifecycle through /api/v1/admin; these would let
 *    a compromised sysadmin session impersonate any user or reset passwords
 *    with no audit trail. The plugin stays configured for its schema fields
 *    (role/banned) and defaultRole — only the routes are blocked.
 *  - update-user: lets any signed-in user rewrite their own `name` and `image`.
 *    `name` is KUKAN's unique username, and this route does not apply
 *    `userNameSchema` — uppercase and whitespace get through, and a collision
 *    surfaces as a 500 from the unique constraint. Renaming is sysadmin's call,
 *    through PATCH /api/v1/admin/users/:userId. If self-service profile editing
 *    is wanted later, it belongs on a KUKAN route that validates (issue #390).
 *
 *  Better Auth's own `disabledPaths` option was the alternative. It matches
 *  exact paths only, so it would need all 15 admin routes named and would miss
 *  whatever a future version adds, and it answers bare text rather than Problem
 *  Details. A prefix here covers the plugin as it grows.
 *
 *  A denylist fails open on upgrade, so `__tests__/auth/route-surface.test.ts`
 *  classifies every path Better Auth mounts and fails when one is unaccounted
 *  for. A path added here belongs in that file's `BLOCKED` too.
 */
function isBlocked(path: string): boolean {
  return path.startsWith('/api/auth/admin/') || path === '/api/auth/update-user'
}

export const authSurface: MiddlewareHandler = async (c, next) => {
  if (isBlocked(c.req.path)) {
    throw new KukanError('The requested resource was not found', 'NOT_FOUND', 404)
  }
  return next()
}
