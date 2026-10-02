/**
 * Run a resource query in a process of its own (ADR-032 remaining issue 2).
 *
 * DuckDB is a native addon: run in the web server's process, a query that
 * reaches the container's limit has the OOM killer take the web server with
 * it, and every page and API route goes down until the task is replaced. Here
 * the query's process is the one that goes (`../child/host.ts`), and the
 * caller gets a refusal instead.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RequestAbandonedError,
  RequestTimeoutError,
  ServiceUnavailableError,
  ValidationError,
} from '@kukan/shared'
import {
  ChildExitedError,
  startChild,
  watchMemory,
  type ChildCommand,
  type ChildHandle,
} from '../child/host'
import {
  QUERY_KILL_GRACE_MS,
  QUERY_PROCESS_RSS_MB,
  QUERY_RSS_POLL_MS,
  QUERY_WEB_HEADROOM_MB,
} from '../../config'
import { timeoutMessage, type SandboxLimits, type SandboxResult } from './duckdb-sandbox'
import {
  FAILURE_CLASSES,
  type QueryFailureKind,
  type QueryReply,
  type QueryRequest,
} from './query-protocol'

let childCommand: ChildCommand | undefined

/**
 * Where the child's code is.
 *
 * **In the image, a file of its own** (`query-child.mjs`, bundled by the
 * package's build, needing nothing beside it but `@duckdb/node-api`). Next
 * bundles this module into its chunks, where `import.meta.url` names a source
 * file that is not on disk, so the image says where it put the child
 * (`QUERY_CHILD_ENTRY`).
 *
 * **Wherever the source is on disk — vitest, tsx, `next dev` — the source,
 * through tsx**, so a change to the sandbox is what runs. Started in this
 * package's directory, where `--import tsx` resolves from its devDependencies:
 * `import.meta.resolve` would say where tsx is, but Turbopack does not provide it.
 */
function resolveChild(): ChildCommand {
  const configured = process.env.QUERY_CHILD_ENTRY
  if (configured) return { entry: configured, execArgv: [] }
  if (import.meta.url.startsWith('file:') && import.meta.url.endsWith('.ts')) {
    const here = dirname(fileURLToPath(import.meta.url))
    return {
      entry: join(here, 'query-child.ts'),
      execArgv: ['--import', 'tsx'],
      cwd: join(here, '../../..'),
    }
  }
  throw new ServiceUnavailableError(
    'The query process cannot be started: set QUERY_CHILD_ENTRY to the built query-child.mjs'
  )
}

/**
 * What a query's process gets of the web server's environment: what loading
 * DuckDB needs, and no more. The query reads its preview through a signed URL,
 * which carries its own authorization. Exported for the test that pins what
 * crosses.
 */
export const QUERY_CHILD_ENV = [
  // Where the image puts libduckdb.so and the extensions fetched at build time
  'LD_LIBRARY_PATH',
  'DUCKDB_EXTENSION_DIRECTORY',
  // The CA bundle httpfs verifies the object store's certificate with
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

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
  // An aborted signal never fires the listener added below
  if (signal?.aborted) throw new RequestAbandonedError()
  childCommand ??= resolveChild()
  const child: ChildHandle = await startChild(childCommand, QUERY_CHILD_ENV, 'kukan-query-proc-')
  const onAbort = () => child.kill(new RequestAbandonedError())
  signal?.addEventListener('abort', onAbort, { once: true })
  // Gone while the process was being started, which the listener never hears
  if (signal?.aborted) onAbort()
  const deadline = setTimeout(
    () => child.kill(new RequestTimeoutError(timeoutMessage(limits.timeoutMs))),
    limits.timeoutMs + QUERY_KILL_GRACE_MS
  )
  const stopWatch = watchMemory(child.proc, {
    budgetMb: rssBudgetMb,
    headroomMb: QUERY_WEB_HEADROOM_MB,
    pollMs: QUERY_RSS_POLL_MS,
    onOver: () => child.kill(tooLarge()),
  })
  let answered = false

  try {
    const reply = await child
      .ask<QueryReply>({ location, sql, limits } satisfies QueryRequest)
      .catch((err: unknown) => {
        if (err instanceof ChildExitedError) return err
        throw err
      })
    if (reply instanceof ChildExitedError) {
      if (reply.outOfMemory) throw tooLarge()
      throw new Error(`The query process exited without answering (${String(reply.exit)})`)
    }
    answered = true
    if (!reply.ok) throw rebuild(reply.kind, reply.message)
    return reply.result
  } finally {
    stopWatch()
    clearTimeout(deadline)
    signal?.removeEventListener('abort', onAbort)
    // One that answered exits by itself
    if (!answered) child.kill()
    await child.stop()
  }
}
