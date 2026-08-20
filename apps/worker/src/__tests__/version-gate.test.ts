import { describe, it, expect } from 'vitest'
import type { VersionIdentity } from '@kukan/shared'
import { decideVersionCreate } from '../pipeline/version-gate'

/** The object a run published; the row still names it unless someone overtook. */
const KEY = 'resources/pkg-1/res-1.run-a'

/**
 * The gate's inputs, defaulting to a run that published CSV bytes to a resource
 * with no versions yet. Each case states only what it is about — the rest are
 * constant noise in most of them.
 */
function decide(
  overrides: Partial<Parameters<typeof decideVersionCreate>[0]> = {},
  /** The reading the highest active version froze, when a case has one. */
  latestActive?: Partial<VersionIdentity>
) {
  return decideVersionCreate({
    identity: { hash: 'sha256:aaa', format: 'CSV', keyColumns: null },
    latestActive: latestActive
      ? { hash: null, format: null, keyColumns: null, ...latestActive }
      : null,
    publishedKey: KEY,
    currentKey: KEY,
    maxVersion: null,
    keyOwnedByPurgingVersion: false,
    ...overrides,
  })
}

describe('decideVersionCreate', () => {
  it('creates v1 when no versions exist yet', () => {
    expect(decide()).toEqual({ created: true, version: 1 })
  })

  it('skips when the latest active version already holds this hash and format', () => {
    expect(decide({ maxVersion: 2 }, { hash: 'sha256:aaa', format: 'CSV' })).toEqual({
      created: false,
    })
  })

  it('creates when only the format changed', () => {
    // How a corrected label reaches content that is already created (ADR-046 §6).
    expect(decide({ maxVersion: 1 }, { hash: 'sha256:aaa', format: 'PDF' })).toEqual({
      created: true,
      version: 2,
    })
  })

  it('creates when only the primary key changed', () => {
    // How a settled key reaches content that is already created (spec §6.4).
    // The bytes never move for this one, so without the key in the gate there
    // is nothing to create and the setting would apply to no version at all.
    expect(
      decide(
        { identity: { hash: 'sha256:aaa', format: 'CSV', keyColumns: ['id'] }, maxVersion: 1 },
        { hash: 'sha256:aaa', format: 'CSV', keyColumns: null }
      )
    ).toEqual({ created: true, version: 2 })
  })

  it('creates when the key columns are reordered', () => {
    // A composite key is the columns in the order chosen: the diff's join is
    // written from the list, so the two describe different comparisons.
    expect(
      decide(
        {
          identity: { hash: 'sha256:aaa', format: 'CSV', keyColumns: ['line', 'order'] },
          maxVersion: 1,
        },
        { hash: 'sha256:aaa', format: 'CSV', keyColumns: ['order', 'line'] }
      )
    ).toEqual({ created: true, version: 2 })
  })

  it('skips when the key is the same list', () => {
    expect(
      decide(
        {
          identity: { hash: 'sha256:aaa', format: 'CSV', keyColumns: ['order', 'line'] },
          maxVersion: 1,
        },
        { hash: 'sha256:aaa', format: 'CSV', keyColumns: ['order', 'line'] }
      )
    ).toEqual({ created: false })
  })

  it('creates when the latest active version records no format at all', () => {
    // A row from before the column existed, or one a deploy-window run inserted
    // without it. Left alone it would never be interpreted.
    expect(decide({ maxVersion: 1 }, { hash: 'sha256:aaa', format: null })).toEqual({
      created: true,
      version: 2,
    })
  })

  it('numbers from the highest row but gates on the latest active one', () => {
    // v3 purged (tombstone) → latest active is v2's hash. New content differs, so
    // it must create as v4 and never collide on the unique index.
    expect(decide({ maxVersion: 3 }, { hash: 'sha256:bbb', format: 'CSV' })).toEqual({
      created: true,
      version: 4,
    })
  })

  it('does not re-create content that is already the live version', () => {
    // The tombstone above does not count: gating on the max row would spawn a
    // spurious version whose bytes are already the live ones.
    expect(
      decide(
        { identity: { hash: 'sha256:bbb', format: 'CSV', keyColumns: null }, maxVersion: 3 },
        { hash: 'sha256:bbb', format: 'CSV' }
      )
    ).toEqual({ created: false })
  })

  it('does not create once another run has published', () => {
    // The reason the check exists: this run's bytes are older than the ones the
    // resource now serves, so filing them would put the live content behind its
    // own latest version.
    expect(
      decide(
        { currentKey: 'resources/pkg-1/res-1.run-b', maxVersion: 2 },
        { hash: 'sha256:bbb', format: 'CSV' }
      )
    ).toEqual({ created: false })
  })

  it('does not create when the resource has no content at all', () => {
    // A purge that emptied the resource clears the pointer; nothing this run
    // published is the content any more.
    expect(decide({ currentKey: null })).toEqual({ created: false })
  })

  it('does not file content whose owning version is being purged', () => {
    // A purge restores the pointer onto an older version's own object and asks
    // for the derivatives to be rebuilt from it. That version can be claimed for
    // purging before the rebuild runs, which takes it out of the active set — so
    // the comparison below would find a difference and copy the content being
    // purged into a version the purge that follows does not recognise as its
    // own, leaving it live under a new number.
    expect(
      decide({ keyOwnedByPurgingVersion: true, maxVersion: 3 }, { hash: 'sha256:older' })
    ).toEqual({ created: false })
  })

  it('files content whose owner is staying, so a stored file can still be repaired', () => {
    // An upload that landed and stopped before its version was created: the
    // repair queues a rebuild, and there is nothing to interpret until this
    // files the version that owns the bytes.
    expect(decide({ keyOwnedByPurgingVersion: false, maxVersion: 3 })).toEqual({
      created: true,
      version: 4,
    })
  })
})
