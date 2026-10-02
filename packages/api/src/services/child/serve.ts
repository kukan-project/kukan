/**
 * The child's half of running work in a process of its own (`host.ts`).
 */

import { writeFileSync } from 'node:fs'
import { setPriority } from 'node:os'

/**
 * Make this process the one to lose: call it first, before loading what the
 * work needs.
 *
 * - **The OOM score.** The container's OOM killer picks the process with the
 *   highest score, and without this the parent, being the larger, would be it.
 *   Raising one's own score needs no privilege; lowering it would
 * - **The CPU priority**, when given, so the work gives way to the parent where
 *   they contend for the task's CPU quota
 * - **The parent's going.** A child left behind by a parent that died holds
 *   memory nothing will ask for again
 */
export function becomeExpendable(niceness?: number): void {
  try {
    writeFileSync('/proc/self/oom_score_adj', '1000')
  } catch {
    // Not Linux: a development machine, where there is no container to protect
  }
  if (niceness !== undefined) {
    try {
      setPriority(niceness)
    } catch {
      // Refused only where priorities are not ours to set; the work runs as it is
    }
  }
  process.once('disconnect', () => process.exit(0))
}
