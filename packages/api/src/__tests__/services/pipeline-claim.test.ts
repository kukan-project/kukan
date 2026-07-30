/**
 * What the claim's SQL fragments actually render to (ADR-044).
 *
 * These are spliced into raw statements in four services, and a `sql` fragment
 * is not type-checked: a missing space, a fragment that renders empty, a
 * condition nested one level deeper than intended — all of them compile, and
 * the statement they land in either does the wrong thing quietly or fails at
 * runtime. The integration suites prove each site refuses a stopped run; this
 * pins the text they are built from, so a change to the composition is visible
 * as a change here rather than as four failing suites elsewhere.
 */
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { heldBy, stillHeld, type ResourceClaim } from '../../services/pipeline-claim'

const dialect = new PgDialect()
const render = (fragment: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(fragment)

const claim: ResourceClaim = {
  id: '00000000-0000-0000-0000-0000000000aa',
  resourceId: '00000000-0000-0000-0000-0000000000bb',
  owner: '00000000-0000-0000-0000-0000000000cc',
}

describe('stillHeld', () => {
  it('renders a subquery naming the row and its owner', () => {
    const { sql, params } = render(stillHeld(claim))

    expect(sql).toBe(
      'EXISTS (SELECT 1 FROM resource_pipeline p WHERE p.id = $1::uuid AND p.claim_owner = $2::uuid)'
    )
    expect(params).toEqual([claim.id, claim.owner])
  })

  it('qualifies both columns', () => {
    // Unqualified, `id` binds to the innermost scope — which is the right table
    // today only because `resource_pipeline` happens to have the column. In a
    // statement whose target table also has one, an alias that stopped being
    // applied would silently compare the wrong row.
    const { sql } = render(stillHeld(claim))

    expect(sql).not.toMatch(/WHERE id/)
    expect(sql).not.toMatch(/AND claim_owner/)
  })

  it('keeps a hostile value a parameter, however deep it is nested', () => {
    // The nesting is what makes this worth pinning: this fragment goes inside
    // another one at four call sites. Composition does not flatten anything to
    // text — each level's interpolations stay bound parameters — and `sql.raw`
    // is the only door text comes through, which in this file takes column
    // names and an alias typed as the literal 'p'.
    const evil = "' OR 1=1; DROP TABLE resource; --"
    const { sql: text, params } = render(
      sql`UPDATE resource SET storage_key = ${evil} WHERE ${stillHeld({
        id: evil,
        resourceId: evil,
        owner: evil,
      })}`
    )

    expect(text).toBe(
      'UPDATE resource SET storage_key = $1 WHERE EXISTS ' +
        '(SELECT 1 FROM resource_pipeline p WHERE p.id = $2::uuid AND p.claim_owner = $3::uuid)'
    )
    expect(params).toEqual([evil, evil, evil])
  })

  it('renders TRUE for a writer with no claim', () => {
    // Not an empty fragment: spliced after an `AND`, empty is a syntax error,
    // and the callers read better for not each deciding this.
    expect(render(stillHeld(null)).sql).toBe('TRUE')
    expect(render(stillHeld(undefined)).sql).toBe('TRUE')
  })
})

describe('heldBy', () => {
  it('renders the bare condition for a statement that already has the row', () => {
    const { sql, params } = render(heldBy(claim))

    expect(sql).toBe('id = $1::uuid AND claim_owner = $2::uuid')
    expect(params).toEqual([claim.id, claim.owner])
  })

  it('qualifies the columns when given an alias', () => {
    expect(render(heldBy(claim, 'p')).sql).toBe('p.id = $1::uuid AND p.claim_owner = $2::uuid')
  })
})
