import { describe, it, expect } from 'vitest'
import { decideVersionCapture } from '../pipeline/version-capture'

/** The object a run published; the row still names it unless someone overtook. */
const KEY = 'resources/pkg-1/res-1.run-a'

describe('decideVersionCapture', () => {
  it('captures v1 when no versions exist yet', () => {
    expect(
      decideVersionCapture({
        hash: 'sha256:aaa',
        publishedKey: KEY,
        currentKey: KEY,
        maxVersion: null,
        latestActiveHash: null,
      })
    ).toEqual({ captured: true, version: 1 })
  })

  it('skips when the latest active version already holds this hash', () => {
    expect(
      decideVersionCapture({
        hash: 'sha256:aaa',
        publishedKey: KEY,
        currentKey: KEY,
        maxVersion: 2,
        latestActiveHash: 'sha256:aaa',
      })
    ).toEqual({ captured: false })
  })

  it('numbers from the highest row but gates on the latest active one', () => {
    // v3 purged (tombstone) → latest active is v2's hash. New content differs, so
    // it must capture as v4 and never collide on the unique index.
    expect(
      decideVersionCapture({
        hash: 'sha256:aaa',
        publishedKey: KEY,
        currentKey: KEY,
        maxVersion: 3,
        latestActiveHash: 'sha256:bbb',
      })
    ).toEqual({ captured: true, version: 4 })
  })

  it('does not re-capture content that is already the live version', () => {
    // The tombstone above does not count: gating on the max row would spawn a
    // spurious version whose bytes are already the live ones.
    expect(
      decideVersionCapture({
        hash: 'sha256:bbb',
        publishedKey: KEY,
        currentKey: KEY,
        maxVersion: 3,
        latestActiveHash: 'sha256:bbb',
      })
    ).toEqual({ captured: false })
  })

  it('does not capture once another run has published', () => {
    // The reason the check exists: this run's bytes are older than the ones the
    // resource now serves, so filing them would put the live content behind its
    // own latest version.
    expect(
      decideVersionCapture({
        hash: 'sha256:aaa',
        publishedKey: KEY,
        currentKey: 'resources/pkg-1/res-1.run-b',
        maxVersion: 2,
        latestActiveHash: 'sha256:bbb',
      })
    ).toEqual({ captured: false })
  })

  it('does not capture when the resource has no content at all', () => {
    // A purge that emptied the resource clears the pointer; nothing this run
    // published is the content any more.
    expect(
      decideVersionCapture({
        hash: 'sha256:aaa',
        publishedKey: KEY,
        currentKey: null,
        maxVersion: null,
        latestActiveHash: null,
      })
    ).toEqual({ captured: false })
  })
})
