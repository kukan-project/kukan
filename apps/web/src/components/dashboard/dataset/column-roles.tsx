'use client'

import {
  Alert,
  AlertDescription,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ColumnRoleBasis, ColumnRolesView } from '@kukan/shared'
import { useFetch } from '@/hooks/use-fetch'
import { columnTypeKey } from '@/lib/format-utils'

/**
 * Each column's role with the rule that decided it (ADR-063 §決定 5). The
 * reasons live here rather than on the public page: they are for whoever
 * checks whether the automatic decision was right.
 */
export function ColumnRoles({
  resourceId,
  reloadKey,
}: {
  resourceId: string
  /** Any change re-reads the roles: a run landing is what rewrites them. */
  reloadKey?: number | string
}) {
  // One namespace: the role and type names are the public page's
  const t = useTranslations('resource')
  const { data: view, error } = useFetch<ColumnRolesView>(
    `/api/v1/resources/${resourceId}/column-roles`,
    reloadKey
  )

  if (error) {
    return (
      <Alert variant="destructive" className="mt-2">
        <AlertDescription>{t('columnRoles.loadError')}</AlertDescription>
      </Alert>
    )
  }
  // Nothing to say rather than a remedy, and nothing while loading for the same
  // reason: no profile covers a JSON that is not a table and an interpretation
  // that failed as well as a table read before roles, and only the last is
  // fixed by a rebuild
  const columns = view?.columns
  if (!columns) return null

  return (
    // `w-0 min-w-full`, as the key's picker: this renders inside a `<td>`, and
    // a wide table here would otherwise set the width of the resource list.
    <div className="mt-2 flex w-0 min-w-full flex-col gap-3 border-t pt-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t('columnRoles.title')}</p>
        <p className="text-muted-foreground text-xs">{t('columnRoles.help')}</p>
        <p className="text-muted-foreground text-xs">
          {t('columnRoles.effects', {
            listed: [t('fieldRoles.name'), t('fieldRoles.category')].join(t('fieldRoleSeparator')),
            free: t('fieldRoles.free-text'),
            unsearched: [
              t('fieldRoles.measure'),
              t('fieldRoles.numeric-text'),
              t('fieldRoles.identifier'),
            ].join(t('fieldRoleSeparator')),
          })}
        </p>
      </div>
      <div className="overflow-x-auto rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('columnRoles.column')}</TableHead>
              <TableHead scope="col">{t('columnRoles.type')}</TableHead>
              <TableHead scope="col">{t('columnRoles.role')}</TableHead>
              <TableHead scope="col">{t('columnRoles.basis')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {columns.map((column, i) => (
              // Headings can repeat; the position cannot
              <TableRow key={i} className="hover:bg-transparent">
                <TableCell className="align-top font-medium">{column.name}</TableCell>
                <TableCell className="align-top">
                  <Badge variant="secondary">{t(columnTypeKey(column.type))}</Badge>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline">{t(`fieldRoles.${column.role}`)}</Badge>
                </TableCell>
                <TableCell className="align-top">
                  <RoleBasis basis={column.roleBasis} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/**
 * Why the rules decided a role. A `numeric-text` column also shows the values
 * that keep it from being a number — the thing to fix for whoever publishes it.
 */
function RoleBasis({ basis }: { basis: ColumnRoleBasis }) {
  const t = useTranslations('resource')
  const percent = basis.share !== undefined ? Math.round(basis.share * 100) : 0
  return (
    <span className="text-muted-foreground text-xs">
      {t(`fieldRoleBasis.${basis.rule}`, { percent, hint: basis.hint ?? '' })}
      {basis.examples && basis.examples.length > 0 && (
        <> {t('fieldRoleNotNumbers', { values: basis.examples.join(t('fieldRoleSeparator')) })}</>
      )}
    </span>
  )
}
