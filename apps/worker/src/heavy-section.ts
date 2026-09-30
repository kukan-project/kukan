/**
 * The work in this process that holds a lot of memory, one piece at a time
 * (ADR-058 §7).
 *
 * With several jobs running at once, a CSV interpretation and a lake ingest
 * would each hold a DuckDB instance capped at 512 MB, and together fill a small
 * task. Everything else a job does — fetching, indexing, asking the AI — goes
 * on beside it.
 *
 * The one boundary for such work: where it would move to a child process, or
 * be weighed against a memory budget rather than counted.
 */
import { inTurn } from '@kukan/shared'

export function heavySection<T>(fn: () => Promise<T>): Promise<T> {
  return inTurn('heavy-section', fn)
}
