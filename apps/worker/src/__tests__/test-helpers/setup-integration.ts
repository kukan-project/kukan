/**
 * Every integration file, before anything queries.
 *
 * A slot's database is copied from the template on demand rather than made up
 * front, because how many slots vitest uses is its decision. `isolate: true`
 * gives each test file its own process, so this runs once per file; the slot's
 * database is then reused by whichever file lands on it next, which is why
 * `cleanDatabase` still has work to do.
 */
import { beforeAll } from 'vitest'
import { prepareTestDatabase } from './test-db'

beforeAll(prepareTestDatabase)
