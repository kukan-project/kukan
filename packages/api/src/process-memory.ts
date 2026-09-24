/**
 * How much memory this process may use.
 *
 * `os.totalmem()` reports the host, which on a 512 MB task is an order of
 * magnitude out, so the container's own cgroup is read first — both layouts,
 * because which one a task gets is the agent's choice rather than ours. On
 * Fargate the container's cgroup holds a limit only if the container itself is
 * given one; the task's is enforced on a parent it cannot read (the infra sets
 * both). Where there is no limit to read (a Compose host that sets none), the
 * host's memory is the truth about what the process may use.
 *
 * Here rather than beside its first caller: the OData feed sizes its
 * concurrency from this, and the query sandbox's own budget is meant to as
 * well — not done yet.
 */

import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'

export interface ProcessMemory {
  memoryMb: number
  source: 'cgroup-v2' | 'cgroup-v1' | 'host'
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

export function processMemory(): ProcessMemory {
  const v2 = readLimitMb('/sys/fs/cgroup/memory.max')
  if (v2) return { memoryMb: v2, source: 'cgroup-v2' }
  const v1 = readLimitMb('/sys/fs/cgroup/memory/memory.limit_in_bytes')
  if (v1) return { memoryMb: v1, source: 'cgroup-v1' }
  return { memoryMb: Math.floor(totalmem() / 1024 / 1024), source: 'host' }
}
