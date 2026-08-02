import { describe, it, expect } from 'vitest'
import { decideVersionCapture } from '../pipeline/version-capture'

/** The object a run published; the row still names it unless someone overtook. */
const KEY = 'resources/pkg-1/res-1.run-a'

/**
 * The gate's inputs, defaulting to a run that published CSV bytes to a resource
 * with no versions yet. Each case states only what it is about — five of the
 * seven fields are constant noise in most of them.
 */
function decide(overrides: Partial<Parameters<typeof decideVersionCapture>[0]> = {}) {
  return decideVersionCapture({
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

describe('decideVersionCapture', () => {
  it('captures v1 when no versions exist yet', () => {
    expect(decide()).toEqual({ captured: true, version: 1 })
  })

  it('skips when the latest active version already holds this hash and format', () => {
    expect(
      decide({ maxVersion: 2, latestActiveHash: 'sha256:aaa', latestActiveFormat: 'CSV' })
    ).toEqual({ captured: false })
  })

  it('captures when only the format changed', () => {
    // How a corrected label reaches content that is already captured (ADR-046 §6).
    expect(
      decide({ maxVersion: 1, latestActiveHash: 'sha256:aaa', latestActiveFormat: 'PDF' })
    ).toEqual({ captured: true, version: 2 })
  })

  it('captures when the latest active version records no format at all', () => {
    // A row from before the column existed, or one a deploy-window run inserted
    // without it. Left alone it would never be interpreted.
    expect(
      decide({ maxVersion: 1, latestActiveHash: 'sha256:aaa', latestActiveFormat: null })
    ).toEqual({ captured: true, version: 2 })
  })

  it('numbers from the highest row but gates on the latest active one', () => {
    // v3 purged (tombstone) → latest active is v2's hash. New content differs, so
    // it must capture as v4 and never collide on the unique index.
    expect(
      decide({ maxVersion: 3, latestActiveHash: 'sha256:bbb', latestActiveFormat: 'CSV' })
    ).toEqual({ captured: true, version: 4 })
  })

  it('does not re-capture content that is already the live version', () => {
    // The tombstone above does not count: gating on the max row would spawn a
    // spurious version whose bytes are already the live ones.
    expect(
      decide({
        hash: 'sha256:bbb',
        maxVersion: 3,
        latestActiveHash: 'sha256:bbb',
        latestActiveFormat: 'CSV',
      })
    ).toEqual({ captured: false })
  })

  it('does not capture once another run has published', () => {
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
    ).toEqual({ captured: false })
  })

  it('does not capture when the resource has no content at all', () => {
    // A purge that emptied the resource clears the pointer; nothing this run
    // published is the content any more.
    expect(decide({ currentKey: null })).toEqual({ captured: false })
  })
})
