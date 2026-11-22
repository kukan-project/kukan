/**
 * What a version's reading needs a person to look at (Versioning ii-c §8.4):
 * found once, when the version's schema is written, and kept on the version
 * row (`resource_version.type_changes`).
 */
import type { ResourceColumn, ResourceColumnType, ResourceSchema } from './pipeline-types'

/** A column's type as read, with a decimal's digits. */
interface ReadType {
  type: ResourceColumnType
  decimalPrecision?: number
  decimalScale?: number
}

export type TypeChange =
  /** A column read by inference took another type than the version before; or a settled decimal other digits */
  | { kind: 'type'; column: string; from: ReadType; to: ReadType }
  /** A settled column with values that did not convert */
  | { kind: 'cast-failures'; column: string; count: number }
  /** A settled column the file does not have */
  | { kind: 'missing'; column: string }
  /** A settled date or timestamp column whose format the values could not decide */
  | { kind: 'date-undecided'; column: string }

/** What a person chose for one change (§8.4). */
export const TYPE_REVIEW_CHOICES = ['accept', 'settle-previous', 'lift'] as const
export type TypeReviewChoice = (typeof TYPE_REVIEW_CHOICES)[number]

/** The record of a review, written once on the version row (`type_review`, §8.8). */
export interface TypeReview {
  /** Gone once the reviewer's account is purged */
  reviewedBy?: string
  reviewedAt: string
  choices: Record<string, TypeReviewChoice>
}

/** The choices a change offers: one that makes a version only where it changes how the column reads. */
export function typeReviewChoices(change: TypeChange): readonly TypeReviewChoice[] {
  switch (change.kind) {
    case 'type':
      // A settled decimal's digits come from its values: writing it back changes nothing
      return change.from.type === 'decimal' && change.to.type === 'decimal'
        ? ['accept']
        : ['accept', 'settle-previous']
    default:
      return ['accept', 'lift']
  }
}

/**
 * The choices for a column, over every change it has: any one of them offers.
 * Lifting a settled type answers values not converted and digits moved alike,
 * where accepting is all the digits alone would offer.
 */
export function typeReviewChoicesFor(
  changes: readonly TypeChange[],
  column: string
): TypeReviewChoice[] {
  const offered = new Set(
    changes.filter((change) => change.column === column).flatMap(typeReviewChoices)
  )
  return TYPE_REVIEW_CHOICES.filter((choice) => offered.has(choice))
}

const readType = (column: ResourceColumn): ReadType => ({
  type: column.type,
  ...(column.decimalPrecision !== undefined && { decimalPrecision: column.decimalPrecision }),
  ...(column.decimalScale !== undefined && { decimalScale: column.decimalScale }),
})

/**
 * What needs review in a version's schema, against the version before it
 * (§8.4); null where nothing does. A column added or dropped is not here: it is
 * the schema diff's. A type that moved with whether the column is settled is
 * not either — that was a person's setting, which made the version.
 */
export function typeChangesOf(
  schema: ResourceSchema,
  previous: ResourceSchema | null
): TypeChange[] | null {
  const changes: TypeChange[] = []
  const before = new Map(previous?.columns.map((column) => [column.name, column]))
  for (const column of schema.columns) {
    if (column.settled) {
      if (column.castFailures) {
        changes.push({ kind: 'cast-failures', column: column.name, count: column.castFailures })
      }
      if (column.dateFormatUndecided) changes.push({ kind: 'date-undecided', column: column.name })
    }
    const prior = before.get(column.name)
    if (!prior || !!prior.settled !== !!column.settled) continue
    const retyped = column.settled
      ? column.type === 'decimal' &&
        prior.type === 'decimal' &&
        (column.decimalPrecision !== prior.decimalPrecision ||
          column.decimalScale !== prior.decimalScale)
      : column.type !== prior.type
    if (retyped) {
      changes.push({
        kind: 'type',
        column: column.name,
        from: readType(prior),
        to: readType(column),
      })
    }
  }
  for (const name of schema.missingSettled ?? []) changes.push({ kind: 'missing', column: name })
  return changes.length > 0 ? changes : null
}
