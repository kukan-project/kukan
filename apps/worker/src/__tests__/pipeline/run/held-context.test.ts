import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '@kukan/db'
import { ConflictError } from '@kukan/shared'
import { heldContext } from '../../../pipeline/run/held-context'
import { RunCancelledError } from '../../../pipeline/run/step-tracker'
import type { PipelineContext } from '../../../pipeline/run/types'

vi.mock('@kukan/api/services/pipeline/pipeline-claim', () => ({
  stillHolds: vi.fn(),
  touchResourceClaim: vi.fn(),
}))

import { touchResourceClaim, type ResourceClaim } from '@kukan/api/services/pipeline/pipeline-claim'

const claim: ResourceClaim = { id: 'claim-1', resourceId: 'res-1', owner: 'run-1' }
const db = {} as Database
const ctx = {} as PipelineContext

describe('heldContext keepHeld', () => {
  beforeEach(() => {
    vi.mocked(touchResourceClaim).mockReset()
  })

  it('touches the claim, so a run working under it does not read as stale', async () => {
    vi.mocked(touchResourceClaim).mockResolvedValue(undefined)
    await heldContext(ctx, claim, db).keepHeld!()
    expect(touchResourceClaim).toHaveBeenCalledWith(db, claim)
  })

  it('cancels the run once the claim no longer holds', async () => {
    vi.mocked(touchResourceClaim).mockRejectedValue(new ConflictError('gone'))
    await expect(heldContext(ctx, claim, db).keepHeld!()).rejects.toThrow(RunCancelledError)
  })

  it('passes any other failure on as it is', async () => {
    const blip = new Error('connection reset')
    vi.mocked(touchResourceClaim).mockRejectedValue(blip)
    await expect(heldContext(ctx, claim, db).keepHeld!()).rejects.toBe(blip)
  })
})
