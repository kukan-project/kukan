/**
 * TLS options for node-postgres, from POSTGRES_SSLMODE.
 */

import { readFileSync } from 'node:fs'
import { createSecureContext, type ConnectionOptions } from 'node:tls'
import { postgresSsl } from '@kukan/shared'

/**
 * The `ssl` option for a pg Pool or Client; undefined for a plain connection.
 *
 * `verify-full` leaves Node's checks on: pg sends the host as the TLS server
 * name, so the certificate must both chain to the bundle and name the host.
 */
export function pgSsl(): ConnectionOptions | undefined {
  const { mode, rootCertPath } = postgresSsl()
  if (mode === 'disable') return undefined
  if (mode === 'require') return { rejectUnauthorized: false }
  if (!rootCertPath) return {}
  // Built once: pg passes `ssl` to every tls.connect, and a bare `ca` would be
  // parsed again for each connection the pool opens
  return { secureContext: createSecureContext({ ca: readFileSync(rootCertPath, 'utf8') }) }
}
