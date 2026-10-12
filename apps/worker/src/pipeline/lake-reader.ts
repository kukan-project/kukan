/**
 * How a rebuild of layer 2 reads a version (ADR-067): the version file
 * interpreted again (ADR-046), as the lake retry reads one.
 *
 * Only the load is a heavy section. The interpretation takes its own turn
 * through the heavy process (ADR-059), and wrapping the whole read in one
 * would have it wait on itself.
 */
import type { LakeVersionReader } from '@kukan/api/services/lake/lake-rebuild'
import { withInterpretedVersion } from './interpret/version'
import { interruptsRun } from '../heavy/process'
import type { PipelineContext } from './run/types'
import { heavySection } from '@/heavy-section'

export function lakeVersionReader(ctx: PipelineContext): LakeVersionReader {
  return async (file, use) => {
    // Whether the throw came out of the load rather than the reading: the
    // load's failures are the catalog's, the reading's are this version's
    let loading = false
    let outcome
    try {
      outcome = await withInterpretedVersion(
        { storageKey: file.storageKey, size: file.size ?? 0 },
        (file.format ?? '').toLowerCase(),
        ctx,
        (table) => {
          loading = true
          return heavySection(() => use(table.parquetPath))
        }
      )
    } catch (err) {
      if (loading || interruptsRun(err)) throw err
      return { table: false, failed: err }
    }
    // A file interpreted to nothing says why; one too large to interpret at all
    // comes back the same way, as `too-large`
    if (outcome.used === undefined) {
      return { table: false, reason: outcome.reason ?? 'no-columns' }
    }
    return { table: true, value: outcome.used }
  }
}
