/**
 * The heavy process as the worker keeps it (ADR-059 §3): started on the first
 * request, reused for the next, and stopped when it has grown, when it has
 * waited long enough, or when it fails.
 */

import {
  ChildExitedError,
  anonymousMb,
  every,
  startChild,
  watchMemory,
  type ChildCommand,
  type ChildHandle,
} from '@kukan/api/services/child/host'
import type { Logger } from '@kukan/shared'
import { JobInterruptedError } from '@kukan/queue'
import type { HeavyReply, HeavyRequest, HeavyResult } from './protocol'

/**
 * The process went with the request: past its own budget, picked by the
 * kernel, or out of heap. One request at a time, so the request is the cause,
 * and running it again gets the same answer.
 *
 * The kernel's pick counts although the parent shares the container: the
 * parent's container bound is read every {@link HeavyLimits.pollMs} and stops
 * the process first where the pressure builds over reads, which leaves what
 * grows faster than that — the work itself.
 */
export class HeavyTooLargeError extends Error {
  constructor() {
    super('It needed more memory than this worker had free for it')
    this.name = 'HeavyTooLargeError'
  }
}

/**
 * The process was stopped because the container as a whole neared its limit,
 * which the worker's other jobs share in: nothing to hold against the request.
 */
export class HeavyShortOfMemoryError extends Error {
  constructor() {
    super('The worker was short of memory; the job will be run again')
    this.name = 'HeavyShortOfMemoryError'
  }
}

/**
 * The worker is stopping, and stopped the run's heavy work (ADR-059) rather
 * than wait out the task's grace period. Unlike `RunCancelledError` the
 * run still holds its resource and its work is still owed: it leaves without
 * recording — a step recorded as failed would say the content cannot be read —
 * and its job fails as one the stop cut short, which the queue hands back
 * uncounted for another task to run.
 */
export class WorkerStoppingError extends JobInterruptedError {
  constructor() {
    super('The worker is stopping')
    this.name = 'WorkerStoppingError'
  }
}

/**
 * Whether `err` cut the work short rather than came of it — the worker stopping,
 * or the container being short — so the run records nothing against the content
 * and its job runs again.
 */
export function interruptsRun(err: unknown): boolean {
  return err instanceof WorkerStoppingError || err instanceof HeavyShortOfMemoryError
}

export interface HeavyLimits {
  /** The child's anonymous memory past which it is killed mid-request. */
  budgetMb: number
  /** What the worker keeps free in the container meanwhile. */
  headroomMb: number
  pollMs: number
  /** The child's anonymous memory past which it is stopped once a request is done. */
  restartMb: number
  /** How long it waits for a request before it is stopped. */
  idleMs: number
  /** How often `check` is called during a request. */
  checkMs: number
}

/** What a child gets of the worker's environment beyond the base keys. */
const HEAVY_CHILD_ENV = ['DUCKDB_EXTENSION_DIRECTORY'] as const

export class HeavyProcess {
  private child: ChildHandle | undefined
  private idle: NodeJS.Timeout | undefined
  /** Set at shutdown: no request runs from then on. */
  private closed = false

  constructor(
    private readonly command: () => ChildCommand,
    private readonly limits: HeavyLimits,
    private readonly options: {
      /**
       * What the worker can give back when the container as a whole is short
       * ({@link HeavyShortOfMemoryError}): called before the request is run
       * once more in a fresh process.
       */
      relieve?: () => Promise<unknown>
      /** Where each start and stop is told, with why: what tunes the limits. */
      log?: Logger
    } = {}
  ) {}

  /**
   * Run `request` in the process, starting one where there is none. The caller
   * sends one request at a time.
   *
   * A process that was reused and went over its budget is replaced and the
   * request run once more: what it kept from earlier requests counts against
   * the budget too, and only a fresh one's going says the request is too large.
   * So is one stopped because the container as a whole was short, once the
   * worker has given back what it can (`relieve`).
   *
   * @param check - called at {@link HeavyLimits.checkMs} while the request
   *   runs; a rejection stops the process and is what this throws.
   */
  async ask<R extends HeavyRequest>(
    request: R,
    check?: () => Promise<void>
  ): Promise<HeavyResult<R>> {
    // Each at most once, in either order, as the first rerun can meet the other
    // bound: a fresh process for one that was reused, and memory given back for
    // a container that was short. Every rerun is in a fresh process
    let reused = this.child?.proc.connected === true
    let relieveOnce = this.options.relieve !== undefined
    for (;;) {
      try {
        return await this.attempt(request, check)
      } catch (err) {
        const wasReused = reused
        reused = false
        if (err instanceof HeavyTooLargeError && wasReused) {
          this.options.log?.info(
            { kind: request.kind },
            'Heavy request run again in a fresh process'
          )
          continue
        }
        if (err instanceof HeavyShortOfMemoryError && relieveOnce) {
          relieveOnce = false
          await this.options.relieve!()
          this.options.log?.info(
            { kind: request.kind },
            'Heavy request run again after the worker gave back memory'
          )
          continue
        }
        throw err
      }
    }
  }

  private async attempt<R extends HeavyRequest>(
    request: R,
    check?: () => Promise<void>
  ): Promise<HeavyResult<R>> {
    if (this.closed) throw new WorkerStoppingError()
    clearTimeout(this.idle)
    // Gone while it waited — the OOM killer's first pick, idle or not
    if (this.child && !this.child.proc.connected) {
      this.options.log?.warn({ pid: this.child.proc.pid }, 'Heavy process went while it waited')
      await this.drop(this.child)
    }
    if (!this.child) {
      const started = await startChild(this.command(), HEAVY_CHILD_ENV, 'kukan-heavy-')
      // Shut down while it was starting, which found nothing to stop
      if (this.closed) {
        started.kill()
        await started.stop()
        throw new WorkerStoppingError()
      }
      this.child = started
      this.options.log?.info({ pid: started.proc.pid, kind: request.kind }, 'Heavy process started')
    }
    const child = this.child
    const stopWatch = watchMemory(child.proc, {
      budgetMb: this.limits.budgetMb,
      read: anonymousMb,
      headroomMb: this.limits.headroomMb,
      pollMs: this.limits.pollMs,
      onOver: (bound) =>
        child.kill(bound === 'child' ? new HeavyTooLargeError() : new HeavyShortOfMemoryError()),
    })
    const stopCheck =
      check &&
      every(this.limits.checkMs, (stopped) =>
        check().catch((err: Error) => {
          if (!stopped()) child.kill(err)
        })
      )

    let reply: HeavyReply
    try {
      reply = await child.ask<HeavyReply>(request)
    } catch (err) {
      // Gone or going, whatever the reason: the next request starts another
      child.kill()
      await this.drop(child)
      this.options.log?.info(
        {
          pid: child.proc.pid,
          kind: request.kind,
          reason:
            err instanceof ChildExitedError ? `exited ${String(err.exit)}` : (err as Error).name,
        },
        'Heavy process stopped during a request'
      )
      if (err instanceof ChildExitedError && err.outOfMemory) {
        throw new HeavyTooLargeError()
      }
      throw err
    } finally {
      stopWatch()
      stopCheck?.()
    }
    await this.rest(child)
    if (!reply.ok) throw new Error(reply.message)
    return reply.result as HeavyResult<R>
  }

  /**
   * At shutdown: kill the request under way, and refuse the rest. Waiting for
   * them would outlast the task's grace period, and the jobs they belong to
   * are run again elsewhere ({@link WorkerStoppingError}).
   */
  async shutdown(): Promise<void> {
    this.closed = true
    this.child?.kill(new WorkerStoppingError())
    await this.stop()
  }

  /** Stop the process, if there is one; the next request starts another. */
  async stop(): Promise<void> {
    clearTimeout(this.idle)
    if (this.child) await this.drop(this.child)
  }

  /** Between requests: start afresh if a parse left it large, or wait for the next. */
  private async rest(child: ChildHandle): Promise<void> {
    const kept = child.proc.pid === undefined ? null : await anonymousMb(child.proc.pid)
    if (kept !== null && kept > this.limits.restartMb) {
      this.options.log?.info(
        { pid: child.proc.pid, keptMb: Math.round(kept) },
        'Heavy process restarted: it kept too much'
      )
      return this.drop(child)
    }
    this.idle = setTimeout(() => {
      this.options.log?.info({ pid: child.proc.pid }, 'Heavy process stopped: idle')
      void this.stop()
    }, this.limits.idleMs)
    // Waiting for a request is no reason to keep the worker from exiting
    this.idle.unref()
  }

  private async drop(child: ChildHandle): Promise<void> {
    if (this.child === child) this.child = undefined
    await child.stop()
  }
}
