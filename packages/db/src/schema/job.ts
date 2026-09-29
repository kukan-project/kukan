/**
 * KUKAN Job Schema
 *
 * The job queue (ADR-058). One row is one job; a job that finishes is deleted,
 * so the table holds only what is waiting, running, or dead.
 *
 * Nothing polls it. The writer wakes the worker once the row is committed, and
 * the worker takes rows until none is ready — so an idle site asks the
 * database nothing, and Aurora can pause.
 */

import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  integer,
  timestamp,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { JOB_PRIORITIES } from '@kukan/shared'

/** Ordered as declared, which is the order jobs are taken in (ADR-058 §6). */
export const jobPriority = pgEnum('job_priority', JOB_PRIORITIES)

export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    /** Not taken before this: a delayed job, or a failed one waiting to be retried. */
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    priority: jobPriority('priority').notNull().default('normal'),
    /** How many times it has been taken, the one that is running included. */
    attempts: integer('attempts').notNull().default(0),
    /** The lease. Null when no worker holds it; a passed one may be taken over. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Which worker holds the lease, so a worker that lost it cannot extend or delete it. */
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    state: varchar('state', { length: 10 }).$type<'ready' | 'dead'>().notNull().default('ready'),
    created: timestamp('created', { withTimezone: true }).defaultNow().notNull(),
    updated: timestamp('updated', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // In the order jobs are taken, which the admin screen lists them in too
    index('idx_job_ready_priority_run_at')
      .on(table.priority, table.runAt, table.id)
      .where(sql`${table.state} = 'ready'`),
    // "Is a job for this resource still on its way?" — asked per request
    // (`readyJobsFor`), and the table holds a whole catalog after a re-enqueue
    index('idx_job_ready_resource')
      .on(table.type, sql`(${table.payload} ->> 'resourceId')`)
      .where(sql`${table.state} = 'ready'`),
  ]
)
