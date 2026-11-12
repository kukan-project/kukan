/**
 * KUKAN Audit Log
 * One row per privileged change, written in the transaction that makes it
 */

import { sql } from 'drizzle-orm'
import type { Database, Transaction } from '@kukan/db'
import { auditLog } from '@kukan/db'
import type { AppContext } from '../context'

/** Who made the change and how they signed in: the request's user, passed as is */
export type AuditActor = Pick<NonNullable<AppContext['user']>, 'id' | 'authMethod'>

export interface AuditEntry {
  entityType: string
  /** Omitted for entities without a uuid id (users): their id goes in `changes` */
  entityId?: string
  action: string
  changes: Record<string, unknown>
}

/** Never put a secret in `changes`: the log is read by every sysadmin and kept. */
export async function writeAudit(
  db: Database | Transaction,
  actor: AuditActor,
  entry: AuditEntry
): Promise<void> {
  await db.insert(auditLog).values({
    entityType: entry.entityType,
    entityId: entry.entityId ?? sql`gen_random_uuid()`,
    action: entry.action,
    userId: actor.id,
    changes: { ...entry.changes, authMethod: actor.authMethod },
  })
}
