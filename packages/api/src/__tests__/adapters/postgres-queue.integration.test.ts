/** The job table as a queue (ADR-058): taking, holding, failing and waking. */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { job } from '@kukan/db'
import { createLogger } from '@kukan/shared'
import { MAX_ATTEMPTS, PostgresQueueAdapter, type Job } from '@kukan/queue-adapter'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const logger = createLogger({ name: 'test', level: 'silent' })
const adapters: PostgresQueueAdapter[] = []

function adapter(notify?: () => Promise<void>, onWaiting?: (count: number) => void) {
  const queue = new PostgresQueueAdapter({ db, logger, notify, onWaiting })
  adapters.push(queue)
  return queue
}

/** Jobs per status, summed over types. */
async function byStatus(queue: PostgresQueueAdapter) {
  const counts = { waiting: 0, running: 0, scheduled: 0, dead: 0 }
  for (const c of await queue.countJobs()) counts[c.status] += c.count
  return counts
}

async function rows() {
  return db.select().from(job).orderBy(job.created)
}

beforeEach(async () => {
  await cleanDatabase()
})

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((q) => q.stop()))
})

afterAll(async () => {
  await closeTestDb()
})

describe('PostgresQueueAdapter', () => {
  it('hands a job to its handler and deletes it once the handler returns', async () => {
    const writer = adapter()
    await writer.enqueue('t', { n: 1 })

    const seen: Job[] = []
    await adapter().process({ t: async (j) => void seen.push(j) })

    await vi.waitFor(async () => expect(await rows()).toHaveLength(0))
    expect(seen).toEqual([expect.objectContaining({ type: 't', data: { n: 1 } })])
  })

  it('takes what is enqueued after it started, from its own wake', async () => {
    const queue = adapter()
    const seen: unknown[] = []
    await queue.process({ t: async (j) => void seen.push(j.data) })

    await queue.enqueue('t', { n: 1 })
    await queue.enqueue('t', { n: 2 })

    await vi.waitFor(() => expect(seen).toEqual([{ n: 1 }, { n: 2 }]))
  })

  it('writes nothing when the transaction it was given rolls back', async () => {
    const queue = adapter()
    const wake = vi.spyOn(queue, 'wake')

    await expect(
      db.transaction(async (tx) => {
        await queue.enqueue('t', {}, { tx })
        throw new Error('rolled back')
      })
    ).rejects.toThrow('rolled back')

    expect(await rows()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
  })

  it('wakes after a transaction commits a job, and not for one that wrote none or rolled back', async () => {
    const queue = adapter()
    const wake = vi.spyOn(queue, 'wake').mockImplementation(() => {})

    await queue.transaction(db, async () => {})
    expect(wake).not.toHaveBeenCalled()

    await expect(
      queue.transaction(db, async (tx) => {
        await queue.enqueue('t', {}, { tx })
        throw new Error('rolled back')
      })
    ).rejects.toThrow('rolled back')
    expect(wake).not.toHaveBeenCalled()

    await queue.transaction(db, async (tx) => {
      await queue.enqueue('t', {}, { tx })
      expect(wake).not.toHaveBeenCalled()
    })
    expect(wake).toHaveBeenCalledOnce()
    expect(await rows()).toHaveLength(1)
  })

  it('holds a delayed job back until it is due', async () => {
    const queue = adapter()
    const handler = vi.fn(async () => {})
    await queue.enqueue('t', {}, { delaySeconds: 3600 })
    await queue.process({ t: handler })

    await vi.waitFor(async () => expect((await byStatus(queue)).scheduled).toBe(1))
    expect(handler).not.toHaveBeenCalled()

    await db.update(job).set({ runAt: sql`now()` })
    queue.wake()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
  })

  it('puts a failed job back to wait, and gives up on it after the last attempt', async () => {
    const queue = adapter()
    const handler = vi.fn(async () => {
      throw new Error('boom')
    })
    await queue.enqueue('t', {})
    await queue.process({ t: handler })

    await vi.waitFor(async () =>
      expect(await rows()).toEqual([
        expect.objectContaining({ state: 'ready', attempts: 1, lastError: 'boom', lockedBy: null }),
      ])
    )
    const [waiting] = await rows()
    expect(waiting.runAt.getTime()).toBeGreaterThan(Date.now())

    await db.update(job).set({ attempts: MAX_ATTEMPTS - 1, runAt: sql`now()` })
    queue.wake()
    await vi.waitFor(async () =>
      expect(await rows()).toEqual([expect.objectContaining({ state: 'dead', attempts: 3 })])
    )
    expect((await byStatus(queue)).dead).toBe(1)
  })

  it('marks dead a job whose worker stopped answering on its last attempt', async () => {
    await adapter().enqueue('t', {})
    await db.update(job).set({
      attempts: MAX_ATTEMPTS,
      lockedUntil: sql`now() - interval '1 minute'`,
      lockedBy: 'gone',
    })

    const handler = vi.fn(async () => {})
    await adapter().process({ t: handler })

    await vi.waitFor(async () =>
      expect(await rows()).toEqual([
        expect.objectContaining({ state: 'dead', lastError: 'Lease expired on the last attempt' }),
      ])
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('takes over a job whose lease has run out', async () => {
    await adapter().enqueue('t', {})
    await db.update(job).set({
      attempts: 1,
      lockedUntil: sql`now() - interval '1 minute'`,
      lockedBy: 'gone',
    })

    const handler = vi.fn(async () => {})
    await adapter().process({ t: handler })

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
  })

  it("takes back a crashed worker's job when its lease runs out, with no signal", async () => {
    // The process that held it is gone and nothing will wake anyone for it;
    // the pass that found it leased comes back at the lease's end.
    await adapter().enqueue('t', {})
    await db.update(job).set({
      attempts: 1,
      lockedUntil: sql`now() + interval '1 second'`,
      lockedBy: 'gone',
    })

    const handler = vi.fn(async () => {})
    await adapter().process({ t: handler })

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), { timeout: 5000 })
  })

  it('leaves a job another worker holds alone', async () => {
    await adapter().enqueue('t', {})
    await db.update(job).set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'other' })

    const handler = vi.fn(async () => {})
    const queue = adapter()
    await queue.process({ t: handler })

    await vi.waitFor(async () => expect((await byStatus(queue)).running).toBe(1))
    expect(handler).not.toHaveBeenCalled()
  })

  it('gives each job to one worker when two take at once', async () => {
    const writer = adapter()
    for (let n = 0; n < 20; n++) await writer.enqueue('t', { n })

    const seen: number[] = []
    const handle = async (j: Job) => {
      seen.push((j.data as { n: number }).n)
      await new Promise((r) => setTimeout(r, 5))
    }
    await Promise.all([adapter().process({ t: handle }), adapter().process({ t: handle })])

    await vi.waitFor(async () => expect(await rows()).toHaveLength(0))
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n))
  })

  it('deletes a job of a type it has no handler for', async () => {
    await adapter().enqueue('unknown', {})
    await adapter().process({})

    await vi.waitFor(async () => expect(await rows()).toHaveLength(0))
  })

  it('sends one signal at a time from a writer, and one more after a burst', async () => {
    let release!: () => void
    const notify = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r
        })
    )
    const writer = adapter(notify)

    await Promise.all(Array.from({ length: 5 }, (_, n) => writer.enqueue('t', { n })))
    expect(notify).toHaveBeenCalledOnce()

    release()
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
    release()
    expect(await rows()).toHaveLength(5)
  })

  it('writes a list of jobs in one call, and wakes once', async () => {
    const notify = vi.fn(async () => {})
    const ids = await adapter(notify).enqueueMany('t', [{ n: 1 }, { n: 2 }, { n: 3 }])

    expect(ids).toHaveLength(3)
    expect((await rows()).map((r) => r.payload)).toEqual(
      expect.arrayContaining([{ n: 1 }, { n: 2 }, { n: 3 }])
    )
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
  })

  it('writes no second job unless-waiting while one waits, and does once a worker holds it', async () => {
    const queue = adapter()
    const first = await queue.enqueue('t', {}, { unlessWaiting: true })
    expect(await queue.enqueue('t', {}, { unlessWaiting: true })).toBe(first)
    expect(await rows()).toHaveLength(1)

    // Taken: the holder may already have looked, so what comes after needs a job
    await db.update(job).set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'other' })
    const second = await queue.enqueue('t', {}, { unlessWaiting: true })

    expect(second).not.toBe(first)
    expect(await rows()).toHaveLength(2)
  })

  it('writes a job unless-waiting past one delayed beyond it, and none past one due sooner', async () => {
    // Wanted now, it cannot wait out another's delay; wanted later, one due
    // sooner sees what the caller wrote
    const queue = adapter()
    const delayed = await queue.enqueue('t', {}, { delaySeconds: 60 })

    const now = await queue.enqueue('t', {}, { unlessWaiting: true })
    expect(now).not.toBe(delayed)
    expect([now, delayed]).toContain(
      await queue.enqueue('t', {}, { delaySeconds: 60, unlessWaiting: true })
    )
    expect(await rows()).toHaveLength(2)
  })

  it('writes a job unless-waiting past one that failed and waits to be retried', async () => {
    // Its retry may be minutes away, or it may never run again
    const queue = adapter()
    const failed = await queue.enqueue('t', {})
    await db
      .update(job)
      .set({ attempts: 1, runAt: sql`now() + interval '5 minutes'` })
      .where(eq(job.id, failed))

    expect(await queue.enqueue('t', {}, { unlessWaiting: true })).not.toBe(failed)
    expect(await rows()).toHaveLength(2)
  })

  it('tells the other tasks about a job a worker writes, and makes a pass itself', async () => {
    // Busy with one job, it would otherwise hold what it queued while another sat idle
    const notify = vi.fn(async () => {})
    const handled: unknown[] = []
    const queue = adapter(notify)
    await queue.process({ t: async (j) => void handled.push(j.data) })

    await queue.enqueue('t', { n: 1 })

    await vi.waitFor(() => expect(handled).toEqual([{ n: 1 }]))
    expect(notify).toHaveBeenCalledOnce()
  })

  it('never forwards a signal it received, so tasks cannot signal each other for ever', async () => {
    const notify = vi.fn(async () => {})
    const handled: unknown[] = []
    const queue = adapter(notify)
    await queue.process({ t: async (j) => void handled.push(j.data) })
    await db.insert(job).values({ type: 't', payload: { n: 1 } })

    queue.wakeHere()

    await vi.waitFor(() => expect(handled).toEqual([{ n: 1 }]))
    expect(notify).not.toHaveBeenCalled()
  })

  it('settles after one signal between two tasks that tell each other', async () => {
    // Each task's signal reaches every task, itself included, as the HTTP one
    // does; a forwarded signal would keep the count climbing
    const tasks: PostgresQueueAdapter[] = []
    const notify = vi.fn(async () => tasks.forEach((t) => t.wakeHere()))
    const handled: unknown[] = []
    for (let i = 0; i < 2; i++) {
      const task = adapter(notify)
      await task.process({ t: async (j) => void handled.push(j.data) })
      tasks.push(task)
    }

    await tasks[0].enqueue('t', { n: 1 })

    await vi.waitFor(() => expect(handled).toEqual([{ n: 1 }]))
    await new Promise((r) => setTimeout(r, 500))
    expect(notify).toHaveBeenCalledOnce()
    expect(handled).toHaveLength(1)
  })

  it('does not fail the enqueue when the signal cannot be sent', async () => {
    const writer = adapter(async () => {
      throw new Error('unreachable')
    })

    await expect(writer.enqueue('t', {})).resolves.toEqual(expect.any(String))
  })

  it('reports the jobs waiting, held ones included, at most once a minute and when the pass ends', async () => {
    const writer = adapter()
    await writer.enqueue('t', {})
    await writer.enqueue('t', {})
    await writer.enqueue('t', {}, { delaySeconds: 3600 })

    const reports: number[] = []
    await adapter(undefined, (count) => reports.push(count)).process({ t: async () => {} })

    // The first take: both due, the one just leased included; the delayed one
    // is not waiting. The second is within the minute and skipped. Last: what
    // the pass could not take.
    await vi.waitFor(() => expect(reports).toEqual([2, 0]))
  })

  it('reports 0 when idle, leaving a job another worker holds to that worker', async () => {
    // Counted by the idle one, it would outlast the holder finishing the job
    await adapter().enqueue('t', {})
    await db.update(job).set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'other' })

    const reports: number[] = []
    await adapter(undefined, (count) => reports.push(count)).process({ t: async () => {} })

    await vi.waitFor(() => expect(reports).toEqual([0]))
  })

  it('keeps counting a failed job while it waits to retry, as SQS counted it in flight', async () => {
    // Read as nothing to do, a wave of failures would scale the service in
    // under the work it still has
    const reports: number[] = []
    const queue = adapter(undefined, (count) => reports.push(count))
    await queue.enqueue('t', {})
    await queue.process({
      t: async () => {
        throw new Error('boom')
      },
    })

    // Taken: 1. Failed, waiting 5 minutes to retry, nobody holding it: still 1
    await vi.waitFor(() => expect(reports).toEqual([1, 1]))
  })

  it('counts a job taken right after a pass ended at 0, within the minute', async () => {
    // Left at 0 while the job ran, the policy would scale in under it
    const reports: number[] = []
    const queue = adapter(undefined, (count) => reports.push(count))
    let release = () => {}
    await queue.process({ t: () => new Promise<void>((r) => (release = r)) })
    try {
      // The start-up pass, on an empty table
      await vi.waitFor(() => expect(reports).toEqual([0]))

      await queue.enqueue('t', {})
      await vi.waitFor(() => expect(reports).toEqual([0, 1]))
    } finally {
      release()
    }
    await vi.waitFor(() => expect(reports).toEqual([0, 1, 0]))
  })

  it('lists jobs by where they stand', async () => {
    const queue = adapter()
    const [waiting, running, scheduled, dead] = await Promise.all([
      queue.enqueue('t', {}),
      queue.enqueue('t', {}),
      queue.enqueue('t', {}, { delaySeconds: 60 }),
      queue.enqueue('t', {}),
    ])
    await db
      .update(job)
      .set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'w' })
      .where(eq(job.id, running))
    await db.update(job).set({ state: 'dead' }).where(eq(job.id, dead))

    const all = await queue.listJobs({ limit: 10, offset: 0 })
    expect(all.total).toBe(4)
    expect(Object.fromEntries(all.items.map((j) => [j.id, j.status]))).toEqual({
      [waiting]: 'waiting',
      [running]: 'running',
      [scheduled]: 'scheduled',
      [dead]: 'dead',
    })
    expect(await queue.listJobs({ status: 'dead', limit: 10, offset: 0 })).toMatchObject({
      total: 1,
      items: [{ id: dead }],
    })
  })

  it('reports the whole total on a page past the end', async () => {
    // The last row of the last page retried or deleted: the page is empty,
    // and the total must still say where the list now ends
    const queue = adapter()
    await queue.enqueue('t', {})
    await queue.enqueue('t', {})
    await db.update(job).set({ state: 'dead' })

    expect(await queue.listJobs({ status: 'dead', limit: 20, offset: 20 })).toEqual({
      items: [],
      total: 2,
    })
  })

  it('prunes dead jobs past their retention, and nothing else', async () => {
    const queue = adapter()
    const [old, recent, waiting] = await Promise.all([
      queue.enqueue('t', {}),
      queue.enqueue('t', {}),
      queue.enqueue('t', {}),
    ])
    await db
      .update(job)
      .set({ state: 'dead', updated: sql`now() - interval '2 days'` })
      .where(eq(job.id, old))
    await db.update(job).set({ state: 'dead' }).where(eq(job.id, recent))
    await db
      .update(job)
      .set({ updated: sql`now() - interval '2 days'` })
      .where(eq(job.id, waiting))

    expect(await queue.pruneDead(24 * 60 * 60 * 1000)).toBe(1)
    expect((await rows()).map((r) => r.id).sort()).toEqual([recent, waiting].sort())
  })

  it('counts jobs by where they are', async () => {
    const queue = adapter()
    const [, held, , dead] = await Promise.all([
      queue.enqueue('t', {}),
      queue.enqueue('t', {}),
      queue.enqueue('t', {}, { delaySeconds: 60 }),
      queue.enqueue('t', {}),
    ])
    await db
      .update(job)
      .set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'w' })
      .where(eq(job.id, held))
    await db.update(job).set({ state: 'dead' }).where(eq(job.id, dead))

    expect(await byStatus(queue)).toEqual({ waiting: 1, running: 1, scheduled: 1, dead: 1 })
  })
})
