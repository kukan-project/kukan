import { describe, it, expect } from 'vitest'
import { decideVersionCreate } from '../pipeline/version-gate'

/** The object a run published; the row still names it unless someone overtook. */
const KEY = 'resources/pkg-1/res-1.run-a'

/**
 * The gate's inputs, defaulting to a run that published CSV bytes to a resource
 * with no versions yet. Each case states only what it is about — five of the
 * seven fields are constant noise in most of them.
 */
function decide(overrides: Partial<Parameters<typeof decideVersionCreate>[0]> = {}) {
  return decideVersionCreate({
    hash: 'sha256:aaa',
    format: 'CSV',
    publishedKey: KEY,
    currentKey: KEY,
    maxVersion: null,
    latestActiveHash: null,
    latestActiveFormat: null,
    ...overrides,
  })
}

describe('decideVersionCreate', () => {
  it('creates v1 when no versions exist yet', () => {
    expect(decide()).toEqual({ created: true, version: 1 })
  })

  it('skips when the latest active version already holds this hash and format', () => {
    expect(
      decide({ maxVersion: 2, latestActiveHash: 'sha256:aaa', latestActiveFormat: 'CSV' })
    ).toEqual({ created: false })
  })

  it('creates when only the format changed', () => {
    // How a corrected label reaches content that is already created (ADR-046 §6).
    expect(
      decide({ maxVersion: 1, latestActiveHash: 'sha256:aaa', latestActiveFormat: 'PDF' })
    ).toEqual({ created: true, version: 2 })
  })

  it('creates when the latest active version records no format at all', () => {
    // A row from before the column existed, or one a deploy-window run inserted
    // without it. Left alone it would never be interpreted.
    expect(
      decide({ maxVersion: 1, latestActiveHash: 'sha256:aaa', latestActiveFormat: null })
    ).toEqual({ created: true, version: 2 })
  })

  it('numbers from the highest row but gates on the latest active one', () => {
    // v3 purged (tombstone) → latest active is v2's hash. New content differs, so
    // it must create as v4 and never collide on the unique index.
    expect(
      decide({ maxVersion: 3, latestActiveHash: 'sha256:bbb', latestActiveFormat: 'CSV' })
    ).toEqual({ created: true, version: 4 })
  })

  it('does not re-create content that is already the live version', () => {
    // The tombstone above does not count: gating on the max row would spawn a
    // spurious version whose bytes are already the live ones.
    expect(
      decide({
        hash: 'sha256:bbb',
        maxVersion: 3,
        latestActiveHash: 'sha256:bbb',
        latestActiveFormat: 'CSV',
      })
    ).toEqual({ created: false })
  })

  it('does not create once another run has published', () => {
    // The reason the check exists: this run's bytes are older than the ones the
    // resource now serves, so filing them would put the live content behind its
    // own latest version.
    expect(
      decide({
        currentKey: 'resources/pkg-1/res-1.run-b',
        maxVersion: 2,
        latestActiveHash: 'sha256:bbb',
        latestActiveFormat: 'CSV',
      })
    ).toEqual({ created: false })
  })

  it('does not create when the resource has no content at all', () => {
    // A purge that emptied the resource clears the pointer; nothing this run
    // published is the content any more.
    expect(decide({ currentKey: null })).toEqual({ created: false })
  })
})
