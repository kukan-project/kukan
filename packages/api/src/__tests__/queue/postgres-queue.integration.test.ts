/** The job table as a queue (ADR-058): taking, holding, failing and waking. */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { job } from '@kukan/db'
import { createLogger } from '@kukan/shared'
import { JobInterruptedError, MAX_ATTEMPTS, PostgresJobQueue, type Job } from '@kukan/queue'
import { getTestDb, cleanDatabase, closeTestDb } from '../test-helpers/test-db'

const db = getTestDb()
const logger = createLogger({ name: 'test', level: 'silent' })
const queues: PostgresJobQueue[] = []

function newQueue(
  notify?: () => Promise<void>,
  onWaiting?: (count: number) => void,
  concurrency?: number
) {
  const queue = new PostgresJobQueue({ db, logger, notify, onWaiting, concurrency })
  queues.push(queue)
  return queue
}

/** A promise and the function that settles it, for a handler to wait on. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

/** Jobs per status, summed over types. */
async function byStatus(queue: PostgresJobQueue) {
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
  await Promise.all(queues.splice(0).map((q) => q.stop()))
})

afterAll(async () => {
  await closeTestDb()
})

describe('PostgresJobQueue', () => {
  it('hands a job to its handler and deletes it once the handler returns', async () => {
    const writer = newQueue()
    await writer.enqueue('t', { n: 1 })

    const seen: Job[] = []
    await newQueue().process({ t: async (j) => void seen.push(j) })

    await vi.waitFor(async () => expect(await rows()).toHaveLength(0))
    expect(seen).toEqual([expect.objectContaining({ type: 't', data: { n: 1 } })])
  })

  it('takes what is enqueued after it started, from its own wake', async () => {
    const queue = newQueue()
    const seen: unknown[] = []
    await queue.process({ t: async (j) => void seen.push(j.data) })

    await queue.enqueue('t', { n: 1 })
    await queue.enqueue('t', { n: 2 })

    await vi.waitFor(() => expect(seen).toEqual([{ n: 1 }, { n: 2 }]))
  })

  it('writes nothing when the transaction it was given rolls back', async () => {
    const queue = newQueue()
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
    const queue = newQueue()
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
    const queue = newQueue()
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
    const queue = newQueue()
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

  it('hands back uncounted a job the stop cut short, even on its last attempt', async () => {
    const writer = newQueue()
    await writer.enqueue('t', {})
    await db.update(job).set({ attempts: MAX_ATTEMPTS - 1 })
    const held = gate()
    const notify = vi.fn(async () => {})
    const queue = newQueue(notify)
    await queue.process({
      t: async () => {
        // What a stop does to the work under way: cuts it short
        await held.opened
        throw new JobInterruptedError()
      },
    })
    await vi.waitFor(async () => expect((await byStatus(queue)).running).toBe(1))

    const stopping = queue.stop()
    held.open()
    await stopping
    const [back] = await rows()
    expect(back).toMatchObject({ state: 'ready', attempts: MAX_ATTEMPTS - 1, lockedBy: null })
    expect(back.runAt.getTime()).toBeLessThanOrEqual(Date.now())
    // And the others told, before the stop returns and the process exits
    expect(notify).toHaveBeenCalled()
  })

  it('counts a job that says it was cut short when the worker is not stopping', async () => {
    // Uncounted and at once, it would run again for ever
    const queue = newQueue()
    await queue.enqueue('t', {})
    await queue.process({
      t: async () => {
        throw new JobInterruptedError()
      },
    })
    await vi.waitFor(async () =>
      expect(await rows()).toEqual([expect.objectContaining({ state: 'ready', attempts: 1 })])
    )
    const [failed] = await rows()
    expect(failed.runAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('counts a job that fails for any other reason while the worker stops', async () => {
    const writer = newQueue()
    await writer.enqueue('t', {})
    const held = gate()
    const queue = newQueue()
    await queue.process({
      t: async () => {
        await held.opened
        throw new Error('boom')
      },
    })
    await vi.waitFor(async () => expect((await byStatus(queue)).running).toBe(1))

    const stopping = queue.stop()
    held.open()
    await stopping
    const [failed] = await rows()
    expect(failed).toMatchObject({ state: 'ready', attempts: 1, lastError: 'boom' })
    expect(failed.runAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('marks dead a job whose worker stopped answering on its last attempt', async () => {
    await newQueue().enqueue('t', {})
    await db.update(job).set({
      attempts: MAX_ATTEMPTS,
      lockedUntil: sql`now() - interval '1 minute'`,
      lockedBy: 'gone',
    })

    const handler = vi.fn(async () => {})
    await newQueue().process({ t: handler })

    await vi.waitFor(async () =>
      expect(await rows()).toEqual([
        expect.objectContaining({ state: 'dead', lastError: 'Lease expired on the last attempt' }),
      ])
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('takes over a job whose lease has run out', async () => {
    await newQueue().enqueue('t', {})
    await db.update(job).set({
      attempts: 1,
      lockedUntil: sql`now() - interval '1 minute'`,
      lockedBy: 'gone',
    })

    const handler = vi.fn(async () => {})
    await newQueue().process({ t: handler })

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
  })

  it("takes back a crashed worker's job when its lease runs out, with no signal", async () => {
    // The process that held it is gone and nothing will wake anyone for it;
    // the pass that found it leased comes back at the lease's end.
    await newQueue().enqueue('t', {})
    await db.update(job).set({
      attempts: 1,
      lockedUntil: sql`now() + interval '1 second'`,
      lockedBy: 'gone',
    })

    const handler = vi.fn(async () => {})
    await newQueue().process({ t: handler })

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), { timeout: 5000 })
  })

  it('leaves a job another worker holds alone', async () => {
    await newQueue().enqueue('t', {})
    await db.update(job).set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'other' })

    const handler = vi.fn(async () => {})
    const queue = newQueue()
    await queue.process({ t: handler })

    await vi.waitFor(async () => expect((await byStatus(queue)).running).toBe(1))
    expect(handler).not.toHaveBeenCalled()
  })

  it('gives each job to one worker when two take at once', async () => {
    const writer = newQueue()
    for (let n = 0; n < 20; n++) await writer.enqueue('t', { n })

    const seen: number[] = []
    const handle = async (j: Job) => {
      seen.push((j.data as { n: number }).n)
      await new Promise((r) => setTimeout(r, 5))
    }
    await Promise.all([newQueue().process({ t: handle }), newQueue().process({ t: handle })])

    await vi.waitFor(async () => expect(await rows()).toHaveLength(0))
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n))
  })

  it('deletes a job of a type it has no handler for', async () => {
    await newQueue().enqueue('unknown', {})
    await newQueue().process({})

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
    const writer = newQueue(notify)

    await Promise.all(Array.from({ length: 5 }, (_, n) => writer.enqueue('t', { n })))
    expect(notify).toHaveBeenCalledOnce()

    release()
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
    release()
    expect(await rows()).toHaveLength(5)
  })

  it('writes a list of jobs in one call, and wakes once', async () => {
    const notify = vi.fn(async () => {})
    const ids = await newQueue(notify).enqueueMany('t', [{ n: 1 }, { n: 2 }, { n: 3 }])

    expect(ids).toHaveLength(3)
    expect((await rows()).map((r) => r.payload)).toEqual(
      expect.arrayContaining([{ n: 1 }, { n: 2 }, { n: 3 }])
    )
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
  })

  it('writes no second job unless-waiting while one waits, and does once a worker holds it', async () => {
    const queue = newQueue()
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
    const queue = newQueue()
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
    const queue = newQueue()
    const failed = await queue.enqueue('t', {})
    await db
      .update(job)
      .set({ attempts: 1, runAt: sql`now() + interval '5 minutes'` })
      .where(eq(job.id, failed))

    expect(await queue.enqueue('t', {}, { unlessWaiting: true })).not.toBe(failed)
    expect(await rows()).toHaveLength(2)
  })

  it('raises a job waiting unless-waiting at a lower priority rather than writing a second', async () => {
    // Left behind the bulk runs it would hold the caller back; passed over,
    // the same work would run twice
    const queue = newQueue()
    const waiting = await queue.enqueue('t', {}, { priority: 'low' })

    expect(await queue.enqueue('t', {}, { unlessWaiting: true, priority: 'normal' })).toBe(waiting)
    expect(await queue.enqueue('t', {}, { unlessWaiting: true, priority: 'low' })).toBe(waiting)

    expect(await rows()).toEqual([expect.objectContaining({ id: waiting, priority: 'normal' })])
  })

  it('writes a job unless-waiting past one waiting with other work in its payload', async () => {
    const queue = newQueue()
    const metadataOnly = await queue.enqueue('t', { includeContent: false })

    const withContent = await queue.enqueue('t', { includeContent: true }, { unlessWaiting: true })
    expect(withContent).not.toBe(metadataOnly)
    expect(await queue.enqueue('t', { includeContent: true }, { unlessWaiting: true })).toBe(
      withContent
    )
    expect(await rows()).toHaveLength(2)
  })

  it('takes the higher priority first, and the earlier within one', async () => {
    const writer = newQueue()
    await writer.enqueue('t', { n: 'low' }, { priority: 'low' })
    await writer.enqueue('t', { n: 'normal, earlier' })
    await writer.enqueue('t', { n: 'high' }, { priority: 'high' })
    await writer.enqueue('t', { n: 'normal, later' }, { priority: 'normal' })
    await db
      .update(job)
      .set({ runAt: sql`now() - interval '1 minute'` })
      .where(sql`${job.payload} ->> 'n' = 'normal, earlier'`)

    const seen: unknown[] = []
    await newQueue().process({ t: async (j) => void seen.push((j.data as { n: string }).n) })

    await vi.waitFor(() =>
      expect(seen).toEqual(['high', 'normal, earlier', 'normal, later', 'low'])
    )
  })

  it('takes a batch written in one statement in the order the admin screen lists it', async () => {
    const writer = newQueue()
    await writer.enqueueMany(
      't',
      Array.from({ length: 8 }, (_, n) => ({ n }))
    )
    const { items } = await writer.listJobs({ status: 'waiting', limit: 10, offset: 0 })

    const seen: unknown[] = []
    await newQueue().process({ t: async (j) => void seen.push(j.data) })

    await vi.waitFor(() => expect(seen).toHaveLength(8))
    expect(seen).toEqual(items.map((j) => j.payload))
  })

  it("writes what a handler queues at that job's priority unless asked otherwise, and the rest at normal", async () => {
    const queue = newQueue()
    const later = { delaySeconds: 3600 }
    await queue.enqueue('parent', {}, { priority: 'high' })
    await queue.enqueue('outside', {}, later)

    await queue.process({
      parent: async () => {
        await queue.enqueue('inherited', {}, later)
        await queue.enqueue('asked', {}, { ...later, priority: 'low' })
        // Works through everything outstanding, so nobody's in particular
        await queue.enqueue('everyones', {}, { ...later, unlessWaiting: true })
      },
    })

    await vi.waitFor(async () => expect(await rows()).toHaveLength(4))
    const byType = Object.fromEntries((await rows()).map((r) => [r.type, r.priority]))
    expect(byType).toEqual({
      outside: 'normal',
      inherited: 'high',
      asked: 'low',
      everyones: 'normal',
    })
  })

  it('keeps its priority through a failed attempt', async () => {
    const queue = newQueue()
    await queue.enqueue('t', {}, { priority: 'low' })
    await queue.process({
      t: async () => {
        throw new Error('boom')
      },
    })

    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ attempts: 1 }))
    expect((await rows())[0].priority).toBe('low')
  })

  it('tells the other tasks about a job a worker writes, and makes a pass itself', async () => {
    // Busy with one job, it would otherwise hold what it queued while another sat idle
    const notify = vi.fn(async () => {})
    const handled: unknown[] = []
    const queue = newQueue(notify)
    await queue.process({ t: async (j) => void handled.push(j.data) })

    await queue.enqueue('t', { n: 1 })

    await vi.waitFor(() => expect(handled).toEqual([{ n: 1 }]))
    expect(notify).toHaveBeenCalledOnce()
  })

  it('never forwards a signal it received, so tasks cannot signal each other for ever', async () => {
    const notify = vi.fn(async () => {})
    const handled: unknown[] = []
    const queue = newQueue(notify)
    await queue.process({ t: async (j) => void handled.push(j.data) })
    await db.insert(job).values({ type: 't', payload: { n: 1 } })

    queue.wakeHere()

    await vi.waitFor(() => expect(handled).toEqual([{ n: 1 }]))
    expect(notify).not.toHaveBeenCalled()
  })

  it('settles after one signal between two tasks that tell each other', async () => {
    // Each task's signal reaches every task, itself included, as the HTTP one
    // does; a forwarded signal would keep the count climbing
    const tasks: PostgresJobQueue[] = []
    const notify = vi.fn(async () => tasks.forEach((t) => t.wakeHere()))
    const handled: unknown[] = []
    for (let i = 0; i < 2; i++) {
      const task = newQueue(notify)
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
    const writer = newQueue(async () => {
      throw new Error('unreachable')
    })

    await expect(writer.enqueue('t', {})).resolves.toEqual(expect.any(String))
  })

  it('reports the jobs waiting, held ones included, at most once a minute and when the pass ends', async () => {
    const writer = newQueue()
    await writer.enqueue('t', {})
    await writer.enqueue('t', {})
    await writer.enqueue('t', {}, { delaySeconds: 3600 })

    const reports: number[] = []
    await newQueue(undefined, (count) => reports.push(count)).process({ t: async () => {} })

    // The first take: both due, the one just leased included; the delayed one
    // is not waiting. The second is within the minute and skipped. Last: what
    // the pass could not take.
    await vi.waitFor(() => expect(reports).toEqual([2, 0]))
  })

  it('reports 0 when idle, leaving a job another worker holds to that worker', async () => {
    // Counted by the idle one, it would outlast the holder finishing the job
    await newQueue().enqueue('t', {})
    await db.update(job).set({ lockedUntil: sql`now() + interval '5 minutes'`, lockedBy: 'other' })

    const reports: number[] = []
    await newQueue(undefined, (count) => reports.push(count)).process({ t: async () => {} })

    await vi.waitFor(() => expect(reports).toEqual([0]))
  })

  it('keeps counting a failed job while it waits to retry, as SQS counted it in flight', async () => {
    // Read as nothing to do, a wave of failures would scale the service in
    // under the work it still has
    const reports: number[] = []
    const queue = newQueue(undefined, (count) => reports.push(count))
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
    const queue = newQueue(undefined, (count) => reports.push(count))
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
    const queue = newQueue()
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

  describe('with a concurrency above one', () => {
    it('runs that many jobs at once, and no more', async () => {
      const writer = newQueue()
      await writer.enqueueMany('t', [{ n: 1 }, { n: 2 }, { n: 3 }])
      const held = gate()
      let now = 0
      let most = 0
      const started: unknown[] = []

      await newQueue(undefined, undefined, 2).process({
        t: async (j) => {
          started.push(j.data)
          most = Math.max(most, ++now)
          await held.opened
          now--
        },
      })

      await vi.waitFor(() => expect(started).toHaveLength(2))
      // The third waits for a loop to come free, however long that takes
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(started).toHaveLength(2)
      held.open()
      await vi.waitFor(async () => expect(await rows()).toHaveLength(0))
      expect(most).toBe(2)
    })

    it('starts a job written while one runs, beside it rather than after it', async () => {
      const queue = newQueue(undefined, undefined, 2)
      const held = gate()
      const started: string[] = []
      await queue.process({
        long: async () => {
          started.push('long')
          await held.opened
        },
        short: async () => void started.push('short'),
      })

      await queue.enqueue('long', {})
      await vi.waitFor(() => expect(started).toEqual(['long']))
      await queue.enqueue('short', {})

      await vi.waitFor(() => expect(started).toEqual(['long', 'short']))
      held.open()
    })

    it('starts a delayed job when it comes due, while another loop is still busy', async () => {
      const queue = newQueue(undefined, undefined, 2)
      const held = gate()
      const started: string[] = []
      await queue.process({
        long: async () => {
          started.push('long')
          await held.opened
        },
        later: async () => void started.push('later'),
      })

      await queue.enqueue('long', {})
      await vi.waitFor(() => expect(started).toEqual(['long']))
      await queue.enqueue('later', {}, { delaySeconds: 1 })

      await vi.waitFor(() => expect(started).toEqual(['long', 'later']), { timeout: 5000 })
      held.open()
    })

    it('keeps the sooner timer when a later time is asked for after it', async () => {
      // Loops ask when the next job is due at once; the answer that lands last
      // may be the oldest, and must not put back a later time
      const queue = newQueue(undefined, undefined, 2)
      const started: string[] = []
      await queue.process({ soon: async () => void started.push('soon') })
      await queue.enqueue('soon', {}, { delaySeconds: 1 })
      await vi.waitFor(async () => expect((await byStatus(queue)).scheduled).toBe(1))
      // The loops the enqueue woke have armed for it and stopped
      await new Promise((resolve) => setTimeout(resolve, 300))

      ;(queue as unknown as { arm(ms: number): void }).arm(3_600_000)

      await vi.waitFor(() => expect(started).toEqual(['soon']), { timeout: 5000 })
    })

    it('waits for every running job when stopped', async () => {
      const writer = newQueue()
      await writer.enqueueMany('t', [{}, {}])
      const held = gate()
      let finished = 0
      const queue = newQueue(undefined, undefined, 2)
      await queue.process({
        t: async () => {
          await held.opened
          finished++
        },
      })
      await vi.waitFor(async () => expect((await byStatus(queue)).running).toBe(2))

      const stopping = queue.stop()
      held.open()
      await stopping
      expect(finished).toBe(2)
    })

    it('reports the waiting jobs as the first is taken and when every loop is idle', async () => {
      const writer = newQueue()
      await writer.enqueueMany('t', [{}, {}, {}])
      const reports: number[] = []

      // Each job waits for the first count: the other loop would otherwise finish
      // jobs while it is still being taken, and it would see fewer than were due
      await newQueue(undefined, (count) => reports.push(count), 2).process({
        t: () => vi.waitFor(() => expect(reports.length).toBeGreaterThan(0)),
      })

      // Not once per loop, nor once per loop going idle
      await vi.waitFor(() => expect(reports).toEqual([3, 0]))
    })
  })

  it('lists waiting jobs in the order they will be taken, with their priority', async () => {
    const queue = newQueue()
    const low = await queue.enqueue('t', {}, { priority: 'low' })
    const normal = await queue.enqueue('t', {})
    const high = await queue.enqueue('t', {}, { priority: 'high' })

    const { items } = await queue.listJobs({ status: 'waiting', limit: 10, offset: 0 })
    expect(items.map((j) => [j.id, j.priority])).toEqual([
      [high, 'high'],
      [normal, 'normal'],
      [low, 'low'],
    ])
  })

  it('reports the whole total on a page past the end', async () => {
    // The last row of the last page retried or deleted: the page is empty,
    // and the total must still say where the list now ends
    const queue = newQueue()
    await queue.enqueue('t', {})
    await queue.enqueue('t', {})
    await db.update(job).set({ state: 'dead' })

    expect(await queue.listJobs({ status: 'dead', limit: 20, offset: 20 })).toEqual({
      items: [],
      total: 2,
    })
  })

  it('prunes dead jobs past their retention, and nothing else', async () => {
    const queue = newQueue()
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
    const queue = newQueue()
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
