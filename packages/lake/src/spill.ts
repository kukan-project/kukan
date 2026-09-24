import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqlLiteral } from './sql'

/**
 * Give this instance somewhere of its own to spill.
 *
 * **DuckDB names a spill file after the block size, not after the instance.**
 * Two in-memory instances in one process that both go out of core write
 * `.tmp/duckdb_temp_storage_S32K-0.tmp` in the working directory, read each
 * other's bytes, and fail — reproduced at two concurrent readers and at four.
 * A process holds several: the CSV interpretation (which materializes a whole
 * file and is documented to spill), the lake's cached instance, a sandboxed
 * query, a feed page.
 *
 * Returns the cleanup to run when the instance closes. Removing the directory
 * is what keeps a container from accumulating one per operation; a failure to
 * remove is swallowed, since the alternative is failing an operation that
 * otherwise succeeded.
 */
export async function useOwnTempDirectory(
  conn: { run(sql: string): Promise<unknown> },
  tag: string
): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), `kukan-${tag}-tmp-`))
  const drop = () => rm(dir, { recursive: true, force: true }).catch(() => {})
  try {
    await conn.run(`SET temp_directory = ${sqlLiteral(dir)}`)
  } catch (err) {
    // The caller never receives the cleanup it did not get a setting for, so
    // the directory would be stranded for the life of the container. Reachable:
    // a read deadline that fires during setup interrupts this very statement.
    await drop()
    throw err
  }
  return drop
}

/**
 * Where a DuckDB instance spills, and when that directory may be removed.
 *
 * **Its spill files outlive `closeSync`.** Closing a DuckDB instance does not
 * stop the connections running on it — they keep the database alive — so
 * removing the directory as it closes takes the files out from under sessions
 * that are still reading them. Measured: a spilling scan on a second connection
 * survives the close and dies on the removal, with an IO error the lake's
 * `isInstanceLost` does not recognise, so its own retry cannot see it.
 *
 * Counting rather than guessing, and counting rather than never removing: an
 * instance rebuilt after a lost connection gets a directory of its own, so a
 * process that loses its credentials repeatedly would collect one per rebuild.
 *
 * The counting is kept separate from the directory below it so it can be tested
 * without a catalog to attach to: it is "hold a resource until both the owner
 * has retired and the borrowers have gone", and nothing more.
 */

interface Held {
  sessions: number
  /** True once the instance is out of service and only its sessions hold it. */
  retired: boolean
  release: () => Promise<void>
  /** Settles once `release` has run — which may be long after `retire`. */
  released: Promise<void>
  settle: () => void
}

export interface SpillRegistry<T> {
  /** Record what to remove when `key` is retired and its sessions are done. */
  track(key: T, release: () => Promise<void>): void
  /**
   * A session opened on `key`.
   *
   * **Take the hold before anything that can await.** A key released in the
   * meantime is gone from the registry, so this becomes a no-op and the session
   * runs unprotected.
   */
  open(key: T): void
  /**
   * A session closed; settles when the removal has, if that was the last holder.
   *
   * Unguarded against being called twice for one session — the caller has to be
   * sure, which `openLakeSession` does with a flag it sets synchronously.
   */
  close(key: T): Promise<void>
  /** `key` is out of service; settles when its last session has let it go. */
  retire(key: T): Promise<void>
}

export function createSpillRegistry<T extends object>(): SpillRegistry<T> {
  const held = new Map<T, Held>()

  const releaseIfDone = (key: T): Promise<void> => {
    const entry = held.get(key)
    if (!entry || !entry.retired || entry.sessions > 0) return Promise.resolve()
    held.delete(key)
    return entry.release().finally(entry.settle)
  }

  return {
    track: (key, release) => {
      let settle!: () => void
      const released = new Promise<void>((resolve) => {
        settle = resolve
      })
      held.set(key, { sessions: 0, retired: false, release, released, settle })
    },
    open: (key) => {
      const entry = held.get(key)
      if (entry) entry.sessions++
    },
    close: (key) => {
      const entry = held.get(key)
      if (entry) entry.sessions--
      return releaseIfDone(key)
    },
    retire: (key) => {
      const entry = held.get(key)
      if (!entry) return Promise.resolve()
      entry.retired = true
      // Not `releaseIfDone`'s own promise: with sessions still open that one
      // settles at once, and a shutdown awaiting it would exit before the last
      // session's `close` had removed anything. This settles when the removal
      // has run, whoever ends up running it.
      void releaseIfDone(key)
      return entry.released
    },
  }
}
