/**
 * KUKAN User Service
 * Business logic for user lifecycle management (update, delete, restore, purge)
 */

import { and, eq, ne, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  user,
  session,
  apiToken,
  packageTable,
  activity,
  auditLog,
  resourceVersion,
} from '@kukan/db'
import { NotFoundError, ConflictError, ValidationError } from '@kukan/shared'
import { writeAudit, type AuditActor } from './audit'

export type UserUpdates = Partial<Pick<typeof user.$inferInsert, 'name' | 'displayName' | 'role'>>

/** Whether another user than `exceptUserId` has `name`: sign-up and a rename ask the same. */
export async function userNameTaken(
  db: Database,
  name: string,
  exceptUserId?: string
): Promise<boolean> {
  const [taken] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.name, name), exceptUserId ? ne(user.id, exceptUserId) : undefined))
    .limit(1)
  return Boolean(taken)
}

export class UserService {
  constructor(private db: Database) {}

  /**
   * Record a user the admin API created. Not in the creating transaction:
   * Better Auth writes the user and its account itself, without one, and runs
   * its own after-hooks only once that is done.
   */
  async recordCreated(created: { id: string; role?: string | null }, actor: AuditActor) {
    await writeAudit(this.db, actor, {
      entityType: 'user',
      action: 'create',
      changes: { userId: created.id, role: created.role ?? 'user' },
    })
  }

  /** Update name, displayName or role; a role change is audited */
  async update(userId: string, updates: UserUpdates, actor: AuditActor) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ role: user.role })
        .from(user)
        .where(eq(user.id, userId))
        // Not FOR UPDATE: the audit row's key share on the actor's own row would
        // deadlock two sysadmins changing each other's roles at once
        .for('no key update')
        .limit(1)
      if (!before) throw new NotFoundError('User')

      const [updated] = await tx
        .update(user)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(user.id, userId))
        .returning({
          id: user.id,
          name: user.name,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          state: user.state,
        })

      if (updates.role !== undefined && updates.role !== before.role) {
        await writeAudit(tx, actor, {
          entityType: 'user',
          action: 'update',
          changes: { userId, previousRole: before.role, role: updated.role },
        })
      }
      return updated
    })
  }

  /** Soft-delete a user: set state='deleted' and revoke sessions/tokens */
  async delete(userId: string, actor: AuditActor) {
    // One transaction, so a user is never left deleted with sessions that still sign in
    await this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(user)
        .set({ state: 'deleted', updatedAt: new Date() })
        .where(eq(user.id, userId))
        .returning({ id: user.id })

      if (!deleted) throw new NotFoundError('User', userId)

      await tx.delete(session).where(eq(session.userId, userId))
      await tx.delete(apiToken).where(eq(apiToken.userId, userId))
      await writeAudit(tx, actor, { entityType: 'user', action: 'delete', changes: { userId } })
    })
  }

  /** Restore a soft-deleted user back to active state */
  async restore(userId: string, actor: AuditActor) {
    await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: user.id, state: user.state })
        .from(user)
        .where(eq(user.id, userId))
        .for('no key update')
        .limit(1)

      if (!target) throw new NotFoundError('User', userId)
      if (target.state !== 'deleted') {
        throw new ValidationError(
          'Only soft-deleted users can be restored',
          undefined,
          'user-not-deleted'
        )
      }

      await tx
        .update(user)
        .set({ state: 'active', updatedAt: new Date() })
        .where(eq(user.id, userId))
      await writeAudit(tx, actor, { entityType: 'user', action: 'restore', changes: { userId } })
    })
  }

  /**
   * Permanently delete a soft-deleted user.
   * Rejects if packages are linked. Nullifies the other references that don't
   * cascade: activity, audit log, and who created or purged a version.
   * Records a purge entry in the audit log.
   */
  async purge(userId: string, actor: AuditActor) {
    await this.db.transaction(async (tx) => {
      // All checks inside transaction to prevent TOCTOU races
      const [target] = await tx
        .select({ id: user.id, email: user.email, name: user.name, state: user.state })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)

      if (!target) throw new NotFoundError('User', userId)
      if (target.state !== 'deleted') {
        throw new ValidationError(
          'Only soft-deleted users can be purged',
          undefined,
          'user-not-deleted'
        )
      }

      const [linkedPkg] = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(eq(packageTable.creatorUserId, userId))
        .limit(1)

      if (linkedPkg) {
        throw new ConflictError(
          'User has linked packages. Purge or reassign them first.',
          undefined,
          'user-has-linked-packages'
        )
      }

      // Nullify FK references that don't cascade. Versions first: a version
      // purge finishing concurrently then either commits its audit row before
      // audit_log is nulled below, or waits on the version row and records no actor
      await tx
        .update(resourceVersion)
        .set({ purgedBy: null, updated: sql`NOW()` })
        .where(eq(resourceVersion.purgedBy, userId))
      await tx
        .update(resourceVersion)
        .set({ createdBy: null, updated: sql`NOW()` })
        .where(eq(resourceVersion.createdBy, userId))
      // And the reviewer a type review names, which is no foreign key to null
      await tx.execute(sql`
        UPDATE resource_version SET type_review = type_review - 'reviewedBy', updated = NOW()
        WHERE type_review->>'reviewedBy' = ${userId}
      `)
      await tx.update(activity).set({ userId: null }).where(eq(activity.userId, userId))
      await tx.update(auditLog).set({ userId: null }).where(eq(auditLog.userId, userId))

      await writeAudit(tx, actor, {
        entityType: 'user',
        action: 'purge',
        changes: { purgedUserId: userId, purgedEmail: target.email, purgedName: target.name },
      })

      // Delete user (CASCADE handles session, account, apiToken, memberships)
      await tx.delete(user).where(eq(user.id, userId))
    })
  }
}
