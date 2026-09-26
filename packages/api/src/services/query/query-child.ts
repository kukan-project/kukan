/**
 * The process a resource query runs in (ADR-032 remaining issue 2).
 *
 * Started by `query-process.ts` for one query and gone after it. Everything
 * the sandbox does is still done here (`duckdb-sandbox.ts`); what this process
 * adds is that when a query outgrows the container, the kernel and the parent
 * have something to kill that is not the web server.
 */

import { writeFileSync } from 'node:fs'
import { setPriority } from 'node:os'
import { runSandboxedQuery } from './duckdb-sandbox'
import {
  FAILURE_CLASSES,
  type ChildMessage,
  type QueryFailureKind,
  type QueryReply,
  type QueryRequest,
} from './query-protocol'

/**
 * Lower than the web server's 0, so a query gives way to page requests when
 * they contend for the task's CPU quota.
 *
 * **Insurance rather than a measured gain.** With six SSR pages in flight on
 * 0.25 vCPU, nice 0, 5, 10 and 19 gave the same page latency and the same query
 * times: the quota binds first, and the split inside it does not show. 19 did
 * not add timeouts either, so a middle value costs nothing where it does not
 * help, and helps where the scheduler turns out to weigh it.
 */
const NICENESS = 10

function kindOf(err: unknown): QueryFailureKind {
  for (const [kind, cls] of Object.entries(FAILURE_CLASSES)) {
    if (err instanceof cls) return kind as QueryFailureKind
  }
  return 'internal'
}

function reply(message: QueryReply): void {
  // Exit only once the reply is on its way: exiting first can drop it.
  process.send!(message, () => process.exit(0))
}

// **The first thing, before DuckDB is loaded.** The container's OOM killer
// picks the process with the highest score, and without this the web server,
// being the larger, would be it. Raising one's own score needs no privilege;
// lowering it would.
try {
  writeFileSync('/proc/self/oom_score_adj', '1000')
} catch {
  // Not Linux: a development machine, where there is no container to protect
}
try {
  setPriority(NICENESS)
} catch {
  // Refused only where priorities are not ours to set; the query runs as it is
}

process.once('message', (request: QueryRequest) => {
  runSandboxedQuery(request.location, request.sql, request.limits).then(
    (result) => reply({ ok: true, result }),
    (err: unknown) =>
      reply({
        ok: false,
        kind: kindOf(err),
        // An internal error's message is what the in-process sandbox would have
        // thrown; the preview URL is already out of it (`materialize`).
        message: err instanceof Error ? err.message : String(err),
      })
  )
})
process.send!({ ready: true } satisfies ChildMessage)
