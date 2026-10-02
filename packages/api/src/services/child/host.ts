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

import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

/**
 * Whether the child has to go.
 *
 * **Two bounds, and on a small task it is the container's that applies.** The
 * child's own budget is what its work may cost where there is room for it. The
 * container's is what keeps the parent alive: its anonymous memory, the
 * parent's included, is what the OOM killer counts, so the child goes while
 * `headroomMb` is still free. Measured against the child's RSS instead, the
 * shared library's pages counted twice and a 512 MB task refused DuckDB queries
 * it had run in process without trouble.
 */
export function overBudget(
  childMb: number | null,
  containerAnonMb: number | null,
  budgetMb: number,
  containerLimitMb: number,
  headroomMb: number
): boolean {
  if (childMb !== null && childMb > budgetMb) return true
  return containerAnonMb !== null && containerAnonMb > containerLimitMb - headroomMb
}

/** A process's resident memory (MiB), or null once it is gone or off Linux. */
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

/** Read once: the limit does not change under a running process. */
const container = processMemory()

interface MemoryWatch {
  /** The child's RSS past which it has to go. */
  budgetMb: number
  /** What the parent keeps free in the container meanwhile. */
  headroomMb: number
  pollMs: number
  /** Called once a read finds it over; the watch goes on until stopped. */
  onOver: () => void
}

/** Watch `child`'s memory and the container's until the returned stop is called. */
export function watchMemory(child: ChildProcess, watch: MemoryWatch): () => void {
  let reading = false
  const poll = setInterval(() => {
    // One read at a time: a busy threadpool would otherwise queue them up
    if (reading || child.pid === undefined) return
    reading = true
    void Promise.all([residentMb(child.pid), containerAnonMb(container.source)]).then(
      ([childMb, anonMb]) => {
        reading = false
        if (overBudget(childMb, anonMb, watch.budgetMb, container.memoryMb, watch.headroomMb)) {
          watch.onOver()
        }
      }
    )
  }, watch.pollMs)
  return () => clearInterval(poll)
}
