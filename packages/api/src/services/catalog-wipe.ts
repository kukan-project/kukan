/**
 * KUKAN Catalog Wipe
 * The database half of DELETE /admin/data: every dataset, organization, group
 * and tag goes; users, settings and the audit log stay
 */

import type { Database } from '@kukan/db'
import { packageTable, organization, group, tag, vocabulary } from '@kukan/db'
import { writeAudit, type AuditActor } from './audit'

export async function deleteAllCatalogData(db: Database, actor: AuditActor) {
  return db.transaction(async (tx) => {
    const pkgs = await tx.delete(packageTable).returning({ id: packageTable.id })
    const orgs = await tx.delete(organization).returning({ id: organization.id })
    const grps = await tx.delete(group).returning({ id: group.id })
    const tgs = await tx.delete(tag).returning({ id: tag.id })
    await tx.delete(vocabulary)
    const counts = {
      packages: pkgs.length,
      organizations: orgs.length,
      groups: grps.length,
      tags: tgs.length,
    }
    await writeAudit(tx, actor, { entityType: 'catalog', action: 'delete_all', changes: counts })
    return counts
  })
}
