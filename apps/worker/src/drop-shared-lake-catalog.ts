/**
 * Drop the shared lake catalog once every resource has moved off it (ADR-067
 * §6). Wiring only — the logic is in `@kukan/api`'s `shared-lake-catalog.ts`.
 *
 * In the deployed container, which is the one with the production database and
 * bucket in reach — once per site's database in a multi-site environment:
 *
 *   node apps/worker/dist/drop-shared-lake-catalog.js            # report only
 *   node apps/worker/dist/drop-shared-lake-catalog.js --commit
 *
 * From a checkout:
 *
 *   pnpm --filter @kukan/worker drop-shared-lake-catalog
 *   pnpm --filter @kukan/worker drop-shared-lake-catalog -- --commit
 *
 * A tsup entry beside `reconcile-orphans`, for the same reason: the image
 * carries `dist` and nothing to run a script with.
 *
 * `--commit` deletes the files and drops the schema, and refuses while any
 * resource is still to be migrated. Past it, an image from before the move can
 * no longer be rolled back to with its layer 2.
 */

import { config } from 'dotenv'
import { createDb } from '@kukan/db'
import { loadEnv } from '@kukan/shared'
import { LAKE_METADATA_SCHEMA } from '@kukan/lake'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import {
  dropSharedLakeCatalog,
  inspectSharedLakeCatalog,
} from '@kukan/api/services/lake/shared-lake-catalog'

// As `index.ts` does: run from the package directory, so the repository's
// `.env` is two levels up. In production the container injects the variables.
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const commit = process.argv.includes('--commit')
const env = loadEnv()
const db = createDb(env.DATABASE_URL)
const storage = new S3StorageAdapter({
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
})

const found = await inspectSharedLakeCatalog(db, storage)
console.log(`Resources still to be migrated: ${found.unmigrated}`)
console.log(`Schema "${LAKE_METADATA_SCHEMA}": ${found.schema ? 'present' : 'absent'}`)
console.log(`Files: ${found.files.length}`)

if (!found.schema && found.files.length === 0) {
  console.log('\nNothing of the shared catalog is left.')
  process.exit(0)
}
if (found.unmigrated > 0) {
  console.log(
    '\nThe migration is not finished: the hourly sweep moves these, or press' +
      ' "Backfill versions" in the admin dashboard. Run again once it shows 0.'
  )
  process.exit(commit ? 1 : 0)
}
if (!commit) {
  console.log('\nRe-run with --commit to delete these files and drop the schema.')
  process.exit(0)
}
await dropSharedLakeCatalog(db, storage)
console.log('\nDropped.')
process.exit(0)
