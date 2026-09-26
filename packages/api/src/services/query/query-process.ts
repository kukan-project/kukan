/**
 * Run a resource query in a process of its own (ADR-032 remaining issue 2).
 *
 * **What this buys is the unit of failure, not memory.** DuckDB is a native
 * addon: run in the web server's process, a query that reaches the container's
 * limit has the OOM killer take the web server with it, and every page and API
 * route goes down until the task is replaced. Here the query's process is the
 * one that goes — killed by the parent once its RSS passes a budget, or picked
 * first by the kernel (`query-child.ts` raises its own OOM score) — and the
 * caller gets a refusal instead.
 *
 * The budget is an approximation: RSS is read at an interval, and nothing short
 * of a cgroup (a sidecar container) enforces a limit exactly. The kernel's
 * choice is what covers the interval.
 */

import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RequestAbandonedError,
  RequestTimeoutError,
  ServiceUnavailableError,
  ValidationError,
} from '@kukan/shared'
import { containerAnonMb, processMemory } from '../../process-memory'
import {
  QUERY_KILL_GRACE_MS,
  QUERY_PROCESS_RSS_MB,
  QUERY_RSS_POLL_MS,
  QUERY_WEB_HEADROOM_MB,
} from '../../config'
import { timeoutMessage, type SandboxLimits, type SandboxResult } from './duckdb-sandbox'
import {
  FAILURE_CLASSES,
  type ChildMessage,
  type QueryFailureKind,
  type QueryReply,
  type QueryRequest,
} from './query-protocol'

interface ChildCommand {
  entry: string
  execArgv: string[]
}

let childCommand: ChildCommand | undefined

/**
 * Where the child's code is. The built child is one self-contained file
 * (`query-child.mjs`, bundled by the package's build) that needs nothing
 * beside it but `@duckdb/node-api`.
 *
 * **Next bundles this module from source**, so inside the web server
 * `import.meta.url` names a `.ts` file that is not on disk and nothing can be
 * found relative to it. The image says where it put the child instead
 * (`QUERY_CHILD_ENTRY`); `next dev` finds it through the package.
 */
function resolveChild(): ChildCommand {
  const configured = process.env.QUERY_CHILD_ENTRY
  if (configured) return { entry: configured, execArgv: [] }
  if (import.meta.url.startsWith('file:')) {
    // Run as itself: vitest and tsx on the source, which tsx runs (resolved
    // from here, not from the working directory), or `node dist/…` on the
    // build. A path rather than `new URL('./…', import.meta.url)`, which
    // Turbopack resolves at build time against the source, where no `.mjs` is.
    const here = dirname(fileURLToPath(import.meta.url))
    return import.meta.url.endsWith('.ts')
      ? {
          entry: join(here, 'query-child.ts'),
          execArgv: ['--import', import.meta.resolve('tsx')],
        }
      : { entry: join(here, 'query-child.mjs'), execArgv: [] }
  }
  try {
    const require = createRequire(join(process.cwd(), 'package.json'))
    return { entry: require.resolve('@kukan/api/query-child'), execArgv: [] }
  } catch {
    throw new ServiceUnavailableError(
      'The query process cannot be started: set QUERY_CHILD_ENTRY to the built query-child.mjs'
    )
  }
}

/**
 * The environment a query's process gets: what loading DuckDB needs, and no
 * more.
 *
 * **An allowlist, because the web server's environment is full of secrets** —
 * the database password, the auth secret, and on ECS the path that hands out
 * the task role's credentials. The query reads its preview through a signed
 * URL, which carries its own authorization, so none of them has a use here.
 */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'NODE_ENV',
  // Where the image puts libduckdb.so and the extensions fetched at build time
  'LD_LIBRARY_PATH',
  'DUCKDB_EXTENSION_DIRECTORY',
  // The CA bundle httpfs verifies the object store's certificate with
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

/** Exported for the test that pins what crosses. */
export function childEnvironment(env: NodeJS.ProcessEnv, tmp: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of INHERITED_ENV) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  // The spill directory is made under this, and the parent removes it: a
  // process killed mid-spill cannot clean up after itself.
  out.TMPDIR = tmp
  return out
}

/** Read once: the limit does not change under a running process. */
const container = processMemory()

/**
 * Whether the query's process has to go. Exported for its test.
 *
 * **Two bounds, and on a small task it is the container's that applies.** The
 * query's own budget is what one query may cost where there is room for it.
 * The container's is what keeps the web server alive: its anonymous memory,
 * the web server's included, is what the OOM killer counts, so the query goes
 * while there is still headroom. Measured against the query's RSS instead,
 * the shared library's pages counted twice and a 512 MB task refused sorts it
 * had run in process without trouble.
 */
export function overBudget(
  childMb: number | null,
  containerAnonMb: number | null,
  budgetMb: number,
  containerLimitMb: number
): boolean {
  if (childMb !== null && childMb > budgetMb) return true
  return containerAnonMb !== null && containerAnonMb > containerLimitMb - QUERY_WEB_HEADROOM_MB
}

async function residentMb(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const kb = /^VmRSS:\s+(\d+) kB$/m.exec(status)
    return kb ? Number(kb[1]) / 1024 : null
  } catch {
    // Gone already, or not Linux — the kernel's choice is all there is then
    return null
  }
}

function rebuild(kind: QueryFailureKind, message: string): Error {
  return kind === 'internal' ? new Error(message) : new FAILURE_CLASSES[kind](message)
}

function tooLarge(): ValidationError {
  return new ValidationError(
    'Query stopped: it needed more memory than this server had free for it. ' +
      'Narrowing it with WHERE or LIMIT, or aggregating before returning rows, makes it lighter'
  )
}

export interface QueryProcessOptions {
  /** The caller's request: when it goes, so does the query's process. */
  signal?: AbortSignal
  /** The RSS budget; defaults to {@link QUERY_PROCESS_RSS_MB}. For tests. */
  rssBudgetMb?: number
}

export async function runQueryInProcess(
  location: string,
  sql: string,
  limits: SandboxLimits,
  { signal, rssBudgetMb = QUERY_PROCESS_RSS_MB }: QueryProcessOptions = {}
): Promise<SandboxResult> {
  let tmp: string | undefined
  let child: ChildProcess | undefined
  let closed: Promise<NodeJS.Signals | number | null> | undefined
  // Why the parent killed it, if it did; a SIGKILL without one is the kernel's
  let killedFor: Error | undefined
  let poll: NodeJS.Timeout | undefined
  let deadline: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  let answered = false

  try {
    tmp = await mkdtemp(join(tmpdir(), 'kukan-query-proc-'))
    // An aborted signal never fires the listener added below
    if (signal?.aborted) throw new RequestAbandonedError()
    childCommand ??= resolveChild()
    child = fork(childCommand.entry, [], {
      // Next declares NODE_ENV required on ProcessEnv; nothing in the child reads it
      env: childEnvironment(process.env, tmp) as NodeJS.ProcessEnv,
      execArgv: childCommand.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const proc = child
    // 'close', not 'exit': it comes once the IPC channel is drained, so a reply
    // sent just before exiting is read before the child is taken to have none
    closed = new Promise((resolve) => proc.once('close', (code, sig) => resolve(sig ?? code)))
    const kill = (error: Error) => {
      killedFor ??= error
      proc.kill('SIGKILL')
    }

    onAbort = () => kill(new RequestAbandonedError())
    signal?.addEventListener('abort', onAbort, { once: true })
    deadline = setTimeout(
      () => kill(new RequestTimeoutError(timeoutMessage(limits.timeoutMs))),
      limits.timeoutMs + QUERY_KILL_GRACE_MS
    )
    let reading = false
    poll = setInterval(() => {
      // One read at a time: a busy threadpool would otherwise queue them up
      if (reading || proc.pid === undefined) return
      reading = true
      void Promise.all([residentMb(proc.pid), containerAnonMb(container.source)]).then(
        ([childMb, anonMb]) => {
          reading = false
          if (overBudget(childMb, anonMb, rssBudgetMb, container.memoryMb)) kill(tooLarge())
        }
      )
    }, QUERY_RSS_POLL_MS)

    const outcome = await new Promise<QueryReply | { exit: NodeJS.Signals | number | null }>(
      (resolve, reject) => {
        // `on`, not `once`, for the child's whole life: a second 'error' (a
        // failed spawn, then a send on its dead channel) with no listener would
        // be thrown in the web server
        proc.on('error', reject)
        proc.on('message', (m: ChildMessage) => {
          // The child loads asynchronously; a request sent before it listens is lost
          if ('ready' in m) {
            const request: QueryRequest = { location, sql, limits }
            proc.send(request, (err) => err && reject(err))
          } else resolve(m)
        })
        void closed!.then((exit) => resolve({ exit }))
      }
    )
    // Whatever it answered (the reply may have won the race against the kill)
    if (killedFor) throw killedFor
    if ('exit' in outcome) {
      // Not the parent, so the kernel: a query is the process it picks first
      if (outcome.exit === 'SIGKILL') throw tooLarge()
      throw new Error(`The query process exited without answering (${String(outcome.exit)})`)
    }
    answered = true
    if (!outcome.ok) throw rebuild(outcome.kind, outcome.message)
    return outcome.result
  } finally {
    clearInterval(poll)
    clearTimeout(deadline)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    // One that answered exits by itself; one that never started has no close to wait for
    if (child?.pid !== undefined) {
      if (!answered) child.kill('SIGKILL')
      await closed
    }
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
