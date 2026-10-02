/**
 * The worker's heavy work, run in a process of its own (ADR-059): CSV
 * interpretation and document text extraction. One request at a time, in the
 * same turn as the lake ingest that stays in this process (`heavySection`).
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containerLimitMb, type ChildCommand } from '@kukan/api/services/child/host'
import { releaseIdleLakeInstances } from '@kukan/lake'
import { createLogger } from '@kukan/shared'
import {
  HEAVY_CLAIM_POLL_MS,
  HEAVY_HEADROOM_MB,
  HEAVY_IDLE_MS,
  HEAVY_PARENT_RESERVE_MB,
  HEAVY_POLL_MS,
  HEAVY_PROCESS_MB,
  HEAVY_RESTART_MB,
} from '@/config'
import { heavySection } from '@/heavy-section'
import { RunCancelledError } from '../pipeline/step-tracker'
import { HeavyProcess } from './process'
import type { HeavyRequest, HeavyResult } from './protocol'

export { HeavyTooLargeError } from './process'

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
      execArgv: ['--import', 'tsx'],
      cwd: join(here, '../..'),
    }
  }
  return { entry: fileURLToPath(new URL('./heavy/child.js', url)), execArgv: [] }
}

const log = createLogger({ name: 'worker' }).child({ component: 'heavy-process' })

const heavy = new HeavyProcess(
  heavyCommand,
  {
    budgetMb: Math.min(HEAVY_PROCESS_MB, containerLimitMb() - HEAVY_PARENT_RESERVE_MB),
    headroomMb: HEAVY_HEADROOM_MB,
    pollMs: HEAVY_POLL_MS,
    restartMb: HEAVY_RESTART_MB,
    idleMs: HEAVY_IDLE_MS,
    checkMs: HEAVY_CLAIM_POLL_MS,
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
 * @param assertHeld - the run's claim check (`heldContext`): a run that has
 *   lost its resource has the process stopped under it. Any other failure of
 *   the check — the database, briefly — lets the work go on.
 */
export function runHeavy<R extends HeavyRequest>(
  request: R,
  assertHeld?: () => Promise<void>
): Promise<HeavyResult<R>> {
  const check =
    assertHeld &&
    (() =>
      assertHeld().catch((err: unknown) => {
        if (err instanceof RunCancelledError) throw err
      }))
  return heavySection(() => heavy.ask(request, check))
}

/** Stop the heavy process at shutdown, and the request under way with it. */
export function stopHeavyProcess(): Promise<void> {
  return heavy.shutdown()
}
