/**
 * The worker's heavy work, run in a process of its own (ADR-059): CSV, JSON
 * and workbook interpretation, document text extraction, and the parsing of
 * an abstract's PDF or image (ADR-053). One request at a time, in the same turn as the lake
 * ingest that stays in this process (`heavySection`).
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containerLimitMb, type ChildCommand } from '@kukan/api/services/child/host'
import { releaseIdleLakeInstances } from '@kukan/lake'
import { createLogger } from '@kukan/shared'
import {
  HEAVY_CLAIM_POLL_MS,
  HEAVY_EXTRACT_TIMEOUT_MS,
  HEAVY_HEADROOM_MB,
  HEAVY_HEAP_SLACK_MB,
  HEAVY_IDLE_MS,
  HEAVY_INTERPRET_TIMEOUT_MS,
  HEAVY_PARENT_RESERVE_MB,
  HEAVY_POLL_MS,
  HEAVY_PROCESS_MB,
  HEAVY_RESTART_MB,
  HEAVY_SUMMARY_TIMEOUT_MS,
} from '@/config'
import { heavySection } from '@/heavy-section'
import { RunCancelledError } from '../pipeline/run/step-tracker'
import { HeavyProcess } from './process'
import type { HeavyRequest, HeavyResult } from './protocol'

export { HeavyTimedOutError, HeavyTooLargeError } from './process'

const budgetMb = Math.min(HEAVY_PROCESS_MB, containerLimitMb() - HEAVY_PARENT_RESERVE_MB)

/**
 * The child's heap, from its budget rather than V8's own sizing from the
 * container, which sat well below the budget: a parser at its edge spent
 * seconds in GC before aborting, long enough for the container's bound to stop
 * it first, as the moment's fault rather than the file's. Kept under where the
 * container's bound fires with the parent at its reserve, too, which on a small
 * task is below the budget: a heap sized to the budget would meet it first again.
 */
const heapMb =
  Math.min(budgetMb, containerLimitMb() - HEAVY_PARENT_RESERVE_MB - HEAVY_HEADROOM_MB) -
  HEAVY_HEAP_SLACK_MB
const HEAVY_HEAP_FLAG = `--max-old-space-size=${Math.max(64, heapMb)}`

/**
 * Where the child's code is. **Run from source** (tsx, vitest), the source
 * through tsx, started in this package's directory where `--import tsx` and the
 * `@/` paths resolve. **Built**, the file tsup writes beside the bundle this
 * module is part of (`dist/heavy/child.js`).
 */
function heavyCommand(): ChildCommand {
  const url = import.meta.url
  if (url.endsWith('.ts')) {
    const here = dirname(fileURLToPath(url))
    return {
      entry: join(here, 'child.ts'),
      execArgv: ['--import', 'tsx', HEAVY_HEAP_FLAG],
      cwd: join(here, '../..'),
    }
  }
  return { entry: fileURLToPath(new URL('./heavy/child.js', url)), execArgv: [HEAVY_HEAP_FLAG] }
}

const log = createLogger({ name: 'worker' }).child({ component: 'heavy-process' })

const heavy = new HeavyProcess(
  heavyCommand,
  {
    budgetMb,
    headroomMb: HEAVY_HEADROOM_MB,
    pollMs: HEAVY_POLL_MS,
    restartMb: HEAVY_RESTART_MB,
    idleMs: HEAVY_IDLE_MS,
    checkMs: HEAVY_CLAIM_POLL_MS,
    timeoutMs: {
      'extract-text': HEAVY_EXTRACT_TIMEOUT_MS,
      'interpret-csv': HEAVY_INTERPRET_TIMEOUT_MS,
      'interpret-json': HEAVY_INTERPRET_TIMEOUT_MS,
      'interpret-workbook': HEAVY_INTERPRET_TIMEOUT_MS,
      'read-pdf': HEAVY_SUMMARY_TIMEOUT_MS,
      'downscale-image': HEAVY_SUMMARY_TIMEOUT_MS,
    },
  },
  {
    // The lake ingest's instance stays open between loads, and what it keeps is
    // what this process has to give back. Run in the same turn as the ingest, so
    // never under one
    relieve: async () => {
      log.info({ released: await releaseIdleLakeInstances() }, 'Idle lake instances released')
    },
    log,
  }
)

/**
 * Run `request` in the heavy process.
 *
 * @param keepHeld - the run's claim touch (`heldContext`): a run that has
 *   lost its resource has the process stopped under it. Any other failure of
 *   it — the database, briefly — lets the work go on.
 */
export function runHeavy<R extends HeavyRequest>(
  request: R,
  keepHeld?: () => Promise<void>
): Promise<HeavyResult<R>> {
  const check =
    keepHeld &&
    (() =>
      keepHeld().catch((err: unknown) => {
        if (err instanceof RunCancelledError) throw err
      }))
  return heavySection(() => heavy.ask(request, check))
}

/** Stop the heavy process at shutdown, and the request under way with it. */
export function stopHeavyProcess(): Promise<void> {
  return heavy.shutdown()
}
