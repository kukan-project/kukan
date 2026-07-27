import { describe, it, expect } from 'vitest'
import { decideVersionCapture } from '../pipeline/version-capture'

describe('decideVersionCapture', () => {
  it('captures v1 when no versions exist yet', () => {
    expect(
      decideVersionCapture({ hash: 'sha256:aaa', maxVersion: null, latestActiveHash: null })
    ).toEqual({ captured: true, version: 1, hash: 'sha256:aaa' })
  })

  it('skips when the latest active version already holds this hash', () => {
    expect(
      decideVersionCapture({ hash: 'sha256:aaa', maxVersion: 2, latestActiveHash: 'sha256:aaa' })
    ).toEqual({ captured: false })
  })

  it('skips when the resource has no content hash', () => {
    expect(decideVersionCapture({ hash: null, maxVersion: null, latestActiveHash: null })).toEqual({
      captured: false,
    })
  })

  it('numbers from the highest row but gates on the latest active one', () => {
    // v3 purged (tombstone) → latest active is v2's hash. New content differs, so
    // it must capture as v4 and never collide on the unique index.
    expect(
      decideVersionCapture({ hash: 'sha256:aaa', maxVersion: 3, latestActiveHash: 'sha256:bbb' })
    ).toEqual({ captured: true, version: 4, hash: 'sha256:aaa' })
  })

  it('does not re-capture content that is already the live version', () => {
    // The tombstone above does not count: gating on the max row would spawn a
    // spurious version whose bytes are already the live ones.
    expect(
      decideVersionCapture({ hash: 'sha256:bbb', maxVersion: 3, latestActiveHash: 'sha256:bbb' })
    ).toEqual({ captured: false })
  })
})
