/**
 * One-off reconciliation of objects that leaked before the write-ahead ledger
 * (ADR-045 open issue 1). Wiring only — the logic is in
 * `cron/orphan-cleanup/reconcile-orphans.ts`.
 *
 * In the deployed container, which is the one with the production database and
 * bucket in reach:
 *
 *   node apps/worker/dist/reconcile-orphans.js            # report only
 *   node apps/worker/dist/reconcile-orphans.js --commit
 *
 * From a checkout:
 *
 *   pnpm --filter @kukan/worker reconcile-orphans
 *   pnpm --filter @kukan/worker reconcile-orphans -- --commit
 *
 * A second tsup entry rather than a file under `scripts/`, because the image
 * carries `dist` and production dependencies and nothing else: no `scripts/`,
 * and no `tsx` to run one with.
 *
 * `--commit` writes ledger rows; it deletes nothing. The hourly sweep does the
 * deleting, and re-checks every key against the live pointers first.
 */

import { config } from 'dotenv'
import { createDb } from '@kukan/db'
import { createLogger, loadEnv } from '@kukan/shared'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { reconcileOrphanedObjects } from './cron/orphan-cleanup/reconcile-orphans'

const MIN_AGE_MS = 24 * 60 * 60 * 1000

// As `index.ts` does: run from the package directory, so the repository's
// `.env` is two levels up. In production the container injects the variables.
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const dryRun = !process.argv.includes('--commit')
const env = loadEnv()
const log = createLogger({ name: 'reconcile-orphans', level: env.LOG_LEVEL })
const db = createDb(env.DATABASE_URL)
const storage = new S3StorageAdapter({
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
})

const result = await reconcileOrphanedObjects(db, storage, log, { minAgeMs: MIN_AGE_MS, dryRun })

// One key per line rather than an array inside a log record: the point of a dry
// run is that someone reads these before committing to them.
for (const key of result.samples) console.log(`  ${key}`)
if (result.nominated > result.samples.length) {
  console.log(`  ... and ${result.nominated - result.samples.length} more`)
}
if (dryRun && result.nominated > 0) {
  console.log('\nRe-run with --commit to hand these to the sweep, which deletes after re-checking.')
}
if (result.tooRecent > 0) {
  console.log(
    `\n${result.tooRecent} unreferenced object(s) are too young to act on. Run again later:` +
      ' this is not finished until both counts are zero.'
  )
}
process.exit(0)
