/**
 * How much memory this process may use.
 *
 * `os.totalmem()` reports the host, which on a 512 MB task is an order of
 * magnitude out, so the container's own cgroup is read first — both layouts,
 * because which one a task gets is the agent's choice rather than ours. On
 * Fargate the container's cgroup holds a limit only if the container itself is
 * given one; the task's is enforced on a parent it cannot read (the infra sets
 * both). Lambda Web Functions have no cgroup to read at all, and their
 * `os.totalmem()` (about 2.4 GB for 2 GB) is not the size they stop at, so the
 * function's configured memory is read there instead (ADR-068). Where there is
 * no limit to read (a Compose host that sets none), the host's memory is the
 * truth about what the process may use.
 *
 * Here rather than beside its caller, the OData feed's concurrency, because
 * nothing about it is the feed's.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'

export interface ProcessMemory {
  memoryMb: number
  source: 'cgroup-v2' | 'cgroup-v1' | 'web-function' | 'host'
}

function readLimitMb(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw === 'max') return null
    const bytes = Number(raw)
    // cgroup v1 writes a sentinel near 2^63 for "no limit"
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) return null
    return Math.floor(bytes / 1024 / 1024)
  } catch {
    return null
  }
}

/**
 * Anonymous memory the container holds now (MiB), or null where there is no
 * cgroup to read.
 *
 * Anonymous only: page cache — a query's spill files among it — is reclaimed
 * before the OOM killer runs, so counting it would call a container full that
 * is not. A Web Function has no cgroup, and `MemTotal - MemAvailable` is the
 * nearest it has: what cannot be reclaimed, the kernel's own share included,
 * which errs toward stopping a child early.
 */
export async function containerAnonMb(source: ProcessMemory['source']): Promise<number | null> {
  if (source === 'host') return null
  // On Linux, libuv reads both from /proc/meminfo (freemem is MemAvailable)
  if (source === 'web-function') return (totalmem() - freemem()) / 1024 / 1024
  try {
    // Literal paths, not picked from a table: Turbopack cannot tell which file a
    // computed path names, and traces the whole project into the image instead
    const bytes =
      source === 'cgroup-v2'
        ? /^anon (\d+)$/m.exec(await readFile('/sys/fs/cgroup/memory.stat', 'utf8'))
        : /^total_rss (\d+)$/m.exec(await readFile('/sys/fs/cgroup/memory/memory.stat', 'utf8'))
    return bytes ? Number(bytes[1]) / 1024 / 1024 : null
  } catch {
    return null
  }
}

export function processMemory(): ProcessMemory {
  const v2 = readLimitMb('/sys/fs/cgroup/memory.max')
  if (v2) return { memoryMb: v2, source: 'cgroup-v2' }
  const v1 = readLimitMb('/sys/fs/cgroup/memory/memory.limit_in_bytes')
  if (v1) return { memoryMb: v1, source: 'cgroup-v1' }
  const webFunction = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE)
  if (webFunction > 0) return { memoryMb: webFunction, source: 'web-function' }
  return { memoryMb: Math.floor(totalmem() / 1024 / 1024), source: 'host' }
}
