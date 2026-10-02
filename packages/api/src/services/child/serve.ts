/**
 * The child's half of running work in a process of its own (`host.ts`).
 */

import { writeFileSync } from 'node:fs'
import { setPriority } from 'node:os'
import type { ReadyMessage } from './host'

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

/**
 * Answer each request with `answer`, then say this process listens: a request
 * the parent sent while it was still loading would be lost.
 *
 * `answer` builds the reply for a failure as well — it never rejects. With
 * `once`, the process answers one request and exits, once the reply is on its
 * way: exiting first can drop it.
 */
export function serve<Request>(
  answer: (request: Request) => Promise<object>,
  { once = false }: { once?: boolean } = {}
): void {
  const onRequest = (request: Request) => {
    void answer(request).then((reply) => {
      if (once) process.send!(reply, () => process.exit(0))
      else process.send!(reply)
    })
  }
  if (once) process.once('message', onRequest)
  else process.on('message', onRequest)
  process.send!({ ready: true } satisfies ReadyMessage)
}
