/**
 * The work in this process that holds a lot of memory, one piece at a time
 * (ADR-058 §7).
 *
 * With several jobs running at once, a CSV interpretation and a lake ingest
 * would each hold a DuckDB instance capped at 512 MB, and together fill a small
 * task; two documents' text extractions would each take a share of one heap,
 * which a 1 GB task caps at 560 MB. Everything else a job does — fetching,
 * writing to the index, asking the AI — goes on beside it.
 *
 * What runs in it now is the heavy process's requests (`heavy/`), and the lake
 * ingest, which stays in this process because it needs the catalog's
 * credentials (ADR-059): one at a time between them, so the ingest's DuckDB and
 * the process's are never both at their caps.
 */
import { inTurn } from '@kukan/shared'

export function heavySection<T>(fn: () => Promise<T>): Promise<T> {
  return inTurn('heavy-section', fn)
}
