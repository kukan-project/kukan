/**
 * The parent's half of running work in a process of its own: the web's
 * resource queries, a process each (ADR-032 remaining issue 2), and the
 * worker's heavy processing, one process reused (ADR-059).
 *
 * **What this buys is the unit of failure, not memory.** Work that reaches the
 * container's limit takes the process it runs in; run here, that is the child,
 * killed by the parent once it passes a budget or picked first by the kernel
 * (`serve.ts` raises its OOM score), and the parent goes on.
 *
 * The budget is an approximation: RSS is read at an interval, and nothing short
 * of a cgroup (a sidecar container) enforces a limit exactly. The kernel's
 * choice is what covers the interval.
 */

import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerAnonMb, processMemory } from '../../process-memory'

/** How to start a child: its entry, and the Node options it needs to load. */
export interface ChildCommand {
  entry: string
  execArgv: string[]
  cwd?: string
}

/**
 * What every child is given of the parent's environment, beside the keys its
 * caller names for what its own work needs to load (a native library's path,
 * say).
 *
 * **An allowlist, because the parent's environment is full of secrets** — the
 * database password, the auth secret, and on ECS the path that hands out the
 * task role's credentials. A child takes local files or signed URLs, which
 * carry their own authorization.
 */
const BASE_CHILD_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'NODE_ENV'] as const

/**
 * The environment a child gets: the base keys and `keys` where the parent has
 * them, and `TMPDIR` pointed at a directory the parent removes — a process
 * killed mid-spill cannot clean up after itself.
 */
export function childEnvironment(
  env: NodeJS.ProcessEnv,
  tmp: string,
  keys: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of [...BASE_CHILD_ENV, ...keys]) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  out.TMPDIR = tmp
  return out
}

/** Which bound a child passed: its own, or the container's. */
export type MemoryBound = 'child' | 'container'

/**
 * Whether the child has to go, and over which bound.
 *
 * **Two bounds, and on a small task it is the container's that applies.** The
 * child's own budget is what its work may cost where there is room for it. The
 * container's is what keeps the parent alive: its anonymous memory, the
 * parent's included, is what the OOM killer counts, so the child goes while
 * `headroomMb` is still free. Measured against the child's RSS instead, the
 * shared library's pages counted twice and a 512 MB task refused DuckDB queries
 * it had run in process without trouble.
 *
 * Which one matters to a caller that records why: the child's own is about its
 * work, the container's may be the parent's doing.
 */
export function overBudget(
  childMb: number | null,
  containerAnonMb: number | null,
  budgetMb: number,
  limitMb: number,
  headroomMb: number
): MemoryBound | null {
  if (childMb !== null && childMb > budgetMb) return 'child'
  if (containerAnonMb !== null && containerAnonMb > limitMb - headroomMb) return 'container'
  return null
}

/** A process's resident memory (MiB), or null once it is gone or off Linux. */
function residentMb(pid: number): Promise<number | null> {
  return statusMb(pid, 'VmRSS')
}

/**
 * A process's anonymous resident memory (MiB): what the container is charged
 * for it alone. Resident memory also counts the pages of the files it maps —
 * Node itself and its native libraries, some 90 MB that the container holds
 * once however many processes map them.
 */
export function anonymousMb(pid: number): Promise<number | null> {
  return statusMb(pid, 'RssAnon')
}

const STATUS_FIELDS = {
  VmRSS: /^VmRSS:\s+(\d+) kB$/m,
  RssAnon: /^RssAnon:\s+(\d+) kB$/m,
}

async function statusMb(pid: number, field: keyof typeof STATUS_FIELDS): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const kb = STATUS_FIELDS[field].exec(status)
    return kb ? Number(kb[1]) / 1024 : null
  } catch {
    // Gone already, or not Linux — the kernel's choice is all there is then
    return null
  }
}

/** Read once: the limit does not change under a running process. */
const container = processMemory()

/** The memory this container may use (MiB): its cgroup limit, or the host's. */
export function containerLimitMb(): number {
  return container.memoryMb
}

interface MemoryWatch {
  /** The child's memory past which it has to go, as `read` measures it. */
  budgetMb: number
  /** How the child's memory is read; its resident memory unless given. */
  read?: (pid: number) => Promise<number | null>
  /** What the parent keeps free in the container meanwhile. */
  headroomMb: number
  pollMs: number
  /** Called once a read finds it over; the watch goes on until stopped. */
  onOver: (bound: MemoryBound) => void
}

/**
 * Call `fn` every `ms`, one call at a time, until the returned stop is called.
 * `fn` is told whether that has happened since it began: what a call under way
 * then finds is about work that is over, and a reused child has moved on.
 */
export function every(ms: number, fn: (stopped: () => boolean) => Promise<void>): () => void {
  let running = false
  let stopped = false
  const isStopped = () => stopped
  const timer = setInterval(() => {
    // One call at a time: a busy threadpool would otherwise queue them up
    if (running) return
    running = true
    void fn(isStopped).finally(() => (running = false))
  }, ms)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** Watch `child`'s memory and the container's until the returned stop is called. */
export function watchMemory(child: ChildProcess, watch: MemoryWatch): () => void {
  return every(watch.pollMs, async (stopped) => {
    if (child.pid === undefined) return
    const [childMb, anonMb] = await Promise.all([
      (watch.read ?? residentMb)(child.pid),
      containerAnonMb(container.source),
    ])
    if (stopped()) return
    const bound = overBudget(childMb, anonMb, watch.budgetMb, container.memoryMb, watch.headroomMb)
    if (bound) watch.onOver(bound)
  })
}

/** What a child sends once it listens (`serve.ts`), before any reply. */
export interface ReadyMessage {
  ready: true
}

/** How a child went without answering: its signal, or its exit code. */
export type ChildExit = NodeJS.Signals | number | null

/**
 * The child went without answering, and the parent had not killed it.
 */
export class ChildExitedError extends Error {
  constructor(readonly exit: ChildExit) {
    super(`The child process exited without answering (${String(exit)})`)
    this.name = 'ChildExitedError'
  }

  /**
   * Whether it went for want of memory: the kernel's OOM kill, the process
   * being its first pick (`serve.ts`), or V8 out of heap, which aborts.
   */
  get outOfMemory(): boolean {
    return this.exit === 'SIGKILL' || this.exit === 'SIGABRT'
  }
}

interface Pending {
  request: unknown
  resolve: (reply: unknown) => void
  reject: (err: unknown) => void
}

/** A child started by {@link startChild}. */
export class ChildHandle {
  /** Why the parent killed it, if it did. */
  private killedFor: Error | undefined
  /** Why it can answer nothing more: it errored, or it is gone. */
  private ended: Error | undefined
  /** Whether it has said it listens: a request sent before is lost. */
  private listening = false
  /** The one request in flight; a reused child is still asked one at a time. */
  private pending: Pending | undefined
  /**
   * Once the process has exited. What {@link stop} waits for: a channel the
   * parent closed itself never brings `'close'`.
   */
  private readonly exited: Promise<void>

  constructor(
    readonly proc: ChildProcess,
    private readonly tmp: string
  ) {
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()))
    // `on`, not `once`, for the child's whole life: a second 'error' (a failed
    // spawn, then a send on its dead channel) with no listener would be thrown
    // in the parent
    proc.on('error', (err) => this.end(err))
    // 'close', not 'exit': it comes once the IPC channel is drained, so a reply
    // sent just before exiting is read before the child is taken to have none
    proc.once('close', (code, sig) => this.end(new ChildExitedError(sig ?? code)))
    proc.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'ready' in message) {
        this.listening = true
        this.send()
      } else this.pending?.resolve(message)
    })
  }

  /**
   * Send `request` and wait for the reply.
   *
   * Throws why the parent killed it where it did — whatever it answered, since
   * the reply may have won the race against the kill — and otherwise
   * {@link ChildExitedError} for a child that went without answering.
   */
  async ask<R>(request: unknown): Promise<R> {
    if (this.pending) throw new Error('The child process is already answering a request')
    try {
      const reply = await new Promise<R>((resolve, reject) => {
        if (this.ended) return reject(this.ended)
        this.pending = { request, resolve: resolve as (reply: unknown) => void, reject }
        this.send()
      })
      if (this.killedFor) throw this.killedFor
      return reply
    } catch (err) {
      throw this.killedFor ?? err
    } finally {
      this.pending = undefined
    }
  }

  /** SIGKILL it, remembering why; the first reason given stands. */
  kill(reason?: Error): void {
    if (reason) this.killedFor ??= reason
    this.proc.kill('SIGKILL')
  }

  /**
   * Have it go and clean up after it: closing the channel ends a child that
   * waits for more (`serve.ts`), and one already gone has nothing to close. Its
   * temporary directory is removed here — a process killed mid-spill cannot
   * remove it itself.
   */
  async stop(): Promise<void> {
    // Closing the channel under a request would leave it unanswered for good:
    // a channel the parent closed never brings the 'close' that settles it
    if (this.pending) this.kill()
    else if (this.proc.connected && !this.proc.killed) this.proc.disconnect()
    // One that never started has no exit to wait for
    if (
      this.proc.pid !== undefined &&
      this.proc.exitCode === null &&
      this.proc.signalCode === null
    ) {
      await this.exited
    }
    await rm(this.tmp, { recursive: true, force: true }).catch(() => {})
  }

  private send(): void {
    const pending = this.pending
    if (!pending || !this.listening) return
    this.proc.send(pending.request as object, (err) => err && pending.reject(err))
  }

  private end(err: Error): void {
    this.ended ??= err
    this.pending?.reject(this.ended)
  }
}

/**
 * Start a child running `command`, with the environment of
 * {@link childEnvironment} and a temporary directory of its own.
 */
export async function startChild(
  command: ChildCommand,
  envKeys: readonly string[],
  tmpPrefix: string
): Promise<ChildHandle> {
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix))
  try {
    // Turbopack follows a `fork` path it can partly evaluate and warns that it
    // cannot resolve it; the child is never part of the bundle
    const proc = fork(/* turbopackIgnore: true */ command.entry, [], {
      // Next declares NODE_ENV required on ProcessEnv; a child reads only what it is given
      env: childEnvironment(process.env, tmp, envKeys) as NodeJS.ProcessEnv,
      execArgv: command.execArgv,
      cwd: command.cwd,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    return new ChildHandle(proc, tmp)
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
