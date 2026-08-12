/**
 * The rule's whole value is what it does *not* flag.
 *
 * A rule that fires on every raw SELECT would be turned off within a week —
 * `db.execute` statements and WHERE fragments are both legitimate and both
 * common here. So the valid cases below are the specification; the invalid one
 * is the bug it was written for, copied from the query that shipped broken.
 */
import { describe, it } from 'vitest'
import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { noRawSubqueryInProjection } from '../no-raw-subquery-in-projection.js'

RuleTester.describe = describe
RuleTester.it = it

// The generics in `sql<boolean>` need the TS parser; take the one the lint
// config already runs on rather than declaring a second.
const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } })

ruleTester.run('no-raw-subquery-in-projection', noRawSubqueryInProjection, {
  valid: [
    // Drizzle builds the subquery; the template only carries it
    {
      code: 'db.select({ formats: sql<string>`${db.select({ agg: sql`x` }).from(resource)}` }).from(resource)',
    },
    // A window function is not a subquery
    { code: 'db.select({ total: sql<number>`COUNT(*) OVER()::int` }).from(resource)' },
    // WHERE is qualified whatever the FROM looks like
    {
      code: 'db.select({ id: resource.id }).from(resource).where(sql`NOT EXISTS (SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})`)',
    },
    // A whole statement drizzle composes nothing of
    { code: 'db.execute(sql`SELECT 1 FROM resource WHERE id = ${id}`)' },
    // A builder embedded in the projection, raw SELECT inside its own .where().
    // The fragment is not a chunk of the field's template, so nothing in it is
    // rewritten — verified against the emitted SQL.
    {
      code: 'db.select({ x: sql<number>`${qb.select({ n: count() }).from(rv).where(sql`NOT EXISTS (SELECT 1 FROM r2 WHERE r2.id = ${resource.id})`)}` }).from(resource)',
    },
    // One level of nesting is already enough to keep the qualifier
    {
      code: 'db.select({ x: sql<boolean>`EXISTS (${sql`SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id}`})` }).from(resource)',
    },
    // No interpolation, so no column to strip
    { code: 'db.select({ x: sql`(SELECT 1)` }).from(resource)' },
    // The SELECT is top-level, but the column is not: wrapped in its own
    // template it lands as an SQL chunk and keeps its qualifier — verified
    // against the emitted SQL.
    {
      code: 'db.select({ n: sql<number>`(SELECT count(*) FROM rv WHERE rv.resource_id = ${sql`${resource.id}`})` }).from(resource)',
    },
    // Only literals interpolated — parameters, not columns
    {
      code: 'db.select({ n: sql<number>`(SELECT count(*) FROM rv WHERE rv.state = ${"active"})` }).from(resource)',
    },
    // Not a projection object
    { code: 'db.select().from(resource)' },
  ],
  invalid: [
    {
      // The purge query as it shipped, which read false for every row
      code: `db.select({
        id: resource.id,
        inLake: sql<boolean>\`EXISTS (SELECT 1 FROM resource_version rv WHERE rv.resource_id = \${resource.id})\`,
      }).from(resource)`,
      errors: [{ messageId: 'raw' }],
    },
    {
      // Lower case, and a count rather than an existence test
      code: 'db.select({ n: sql<number>`(select count(*) from rv where rv.resource_id = ${resource.id})` }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
    {
      // Still the field's own template behind .as()
      code: 'db.select({ n: sql<number>`(SELECT count(*) FROM rv WHERE rv.resource_id = ${resource.id})`.as("n") }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
    // The type-only wrappers below are gone at runtime, so each is the same
    // broken query written so the rule would not see it.
    {
      code: 'db.select({ n: sql`(SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})` as SQL }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
    {
      code: 'db.select({ n: sql`(SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})` satisfies SQL }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
    {
      code: 'db.select({ n: <SQL>sql`(SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})` }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
    {
      code: 'db.select({ n: sql`(SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})`! }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
    {
      // A gated field: the arm that runs is still the field's own template
      code: 'db.select({ n: viewer ? sql`(SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})` : sql`NULL::int` }).from(resource)',
      errors: [{ messageId: 'raw' }],
    },
  ],
})
