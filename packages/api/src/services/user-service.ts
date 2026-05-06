/**
 * KUKAN User Service
 * Business logic for user lifecycle management (delete, restore, purge)
 */

import { eq, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { user, session, apiToken, packageTable, activity, auditLog } from '@kukan/db'
import { NotFoundError, ConflictError, ValidationError } from '@kukan/shared'

export class UserService {
  constructor(private db: Database) {}

  /** Soft-delete a user: set state='deleted' and revoke sessions/tokens */
  async delete(userId: string) {
    const [deleted] = await this.db
      .update(user)
      .set({ state: 'deleted', updatedAt: new Date() })
      .where(eq(user.id, userId))
      .returning({ id: user.id })

    if (!deleted) throw new NotFoundError('User', userId)

    await Promise.all([
      this.db.delete(session).where(eq(session.userId, userId)),
      this.db.delete(apiToken).where(eq(apiToken.userId, userId)),
    ])
  }

  /** Restore a soft-deleted user back to active state */
  async restore(userId: string) {
    const [target] = await this.db
      .select({ id: user.id, state: user.state })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)

    if (!target) throw new NotFoundError('User', userId)
    if (target.state !== 'deleted') {
      throw new ValidationError('Only soft-deleted users can be restored')
    }

    await this.db
      .update(user)
      .set({ state: 'active', updatedAt: new Date() })
      .where(eq(user.id, userId))
  }

  /**
   * Permanently delete a soft-deleted user.
   * Rejects if packages are linked. Nullifies activity/auditLog references.
   * Records a purge entry in the audit log.
   */
  async purge(userId: string, performedBy: string) {
    await this.db.transaction(async (tx) => {
      // All checks inside transaction to prevent TOCTOU races
      const [target] = await tx
        .select({ id: user.id, email: user.email, name: user.name, state: user.state })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)

      if (!target) throw new NotFoundError('User', userId)
      if (target.state !== 'deleted') {
        throw new ValidationError('Only soft-deleted users can be purged')
      }

      const [linkedPkg] = await tx
        .select({ id: packageTable.id })
        .from(packageTable)
        .where(eq(packageTable.creatorUserId, userId))
        .limit(1)

      if (linkedPkg) {
        throw new ConflictError('User has linked packages. Purge or reassign them first.')
      }

      // Nullify FK references that don't cascade
      await tx.update(activity).set({ userId: null }).where(eq(activity.userId, userId))
      await tx.update(auditLog).set({ userId: null }).where(eq(auditLog.userId, userId))

      // Record the purge in audit log
      // entityId is uuid; Better Auth user IDs are text, so store in changes instead
      await tx.insert(auditLog).values({
        entityType: 'user',
        entityId: sql`gen_random_uuid()`,
        action: 'purge',
        userId: performedBy,
        changes: { purgedUserId: userId, purgedEmail: target.email, purgedName: target.name },
      })

      // Delete user (CASCADE handles session, account, apiToken, memberships)
      await tx.delete(user).where(eq(user.id, userId))
    })
  }
}
