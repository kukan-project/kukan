/**
 * The feed's DuckDB instances, kept between pages (ADR-055).
 *
 * Preparing one — the extensions, the secret, the seal — cost about 18 ms of a
 * page that reads in 25–160, and a credential-chain deployment adds the `aws`
 * load and the chain's resolution on top. A kept instance costs a page one
 * `connect()`. What it must not keep is what the pages read, which is why
 * both of DuckDB's caches are off (`prepareFeedInstance`); with them off a kept
 * instance read 180 distinct files and stayed flat.
 *
 * What a kept instance does hold is about 44 MB of RSS that only closing it
 * gives back (no allocator or httpfs setting moved it). That is inside the
 * page budget `capacity` already sets aside for its slot.
 *
 * No bound of its own: the caller holds a slot of the feed's semaphore for as
 * long as it holds an instance, so no more are ever in use than there are
 * slots, and an idle one is only ever one that was in use.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import type { DuckdbHandle } from '@kukan/lake'
import { isS3Location, type SessionOptions } from './session'

export interface FeedLease {
  conn: DuckDBConnection
  /**
   * Hand the instance back. `reusable: false` closes it instead — for a page
   * that failed or timed out, whose instance may still be finishing a request
   * the deadline could not stop, or one whose result was not read to its end.
   */
  release: (reusable: boolean) => Promise<void>
}

type Kept = Pick<DuckdbHandle, 'instance' | 'dropTempDir'> & { preparedAt: number }

/**
 * What an instance was prepared for. The secret is scoped to one bucket and a
 * local read keeps a filesystem an S3 one refuses, so neither may serve the
 * other. The limits are the same for every page of a process.
 */
function scopeOf(opts: SessionOptions): string {
  return isS3Location(opts.location) ? new URL(opts.location).host : ''
}

async function closeKept(kept: Kept): Promise<void> {
  try {
    kept.instance.closeSync()
  } finally {
    await kept.dropTempDir()
  }
}

export function createFeedPool(deps: {
  prepare: (opts: SessionOptions) => Promise<DuckdbHandle>
  /** How long an unused instance is kept before it is closed. */
  idleMs: number
  /** How long after it was prepared an instance is no longer handed back. */
  maxAgeMs: number
}) {
  // Most recently returned last, and taken from the end: under light traffic
  // the same instance serves every page and the rest age out.
  const idle = new Map<string, { kept: Kept; timer: NodeJS.Timeout }[]>()

  function keep(scope: string, kept: Kept) {
    const list = idle.get(scope) ?? []
    idle.set(scope, list)
    const entry = {
      kept,
      // Unref'd: a kept instance is no reason for the process to stay up.
      timer: setTimeout(() => {
        list.splice(list.indexOf(entry), 1)
        void closeKept(kept)
      }, deps.idleMs).unref(),
    }
    list.push(entry)
  }

  async function acquire(opts: SessionOptions): Promise<FeedLease> {
    const scope = scopeOf(opts)
    const entry = idle.get(scope)?.pop()
    let kept: Kept
    let conn: DuckDBConnection
    if (entry) {
      clearTimeout(entry.timer)
      kept = entry.kept
      try {
        conn = await kept.instance.connect()
      } catch (err) {
        await closeKept(kept)
        throw err
      }
    } else {
      const handle = await deps.prepare(opts)
      kept = { instance: handle.instance, dropTempDir: handle.dropTempDir, preparedAt: Date.now() }
      conn = handle.conn
    }

    let released = false
    return {
      conn,
      release: async (reusable) => {
        if (released) return
        released = true
        try {
          conn.disconnectSync()
        } catch {
          reusable = false
        }
        if (reusable && Date.now() - kept.preparedAt < deps.maxAgeMs) keep(scope, kept)
        else await closeKept(kept)
      },
    }
  }

  /** Close every idle instance. For tests: nothing outside them needs it. */
  async function drain(): Promise<void> {
    const all = [...idle.values()].flat()
    idle.clear()
    for (const { timer } of all) clearTimeout(timer)
    await Promise.all(all.map(({ kept }) => closeKept(kept)))
  }

  return { acquire, drain }
}
