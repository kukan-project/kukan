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

/**
 * No guessability check unless a file asks for one.
 *
 * Scoring loads several MB of dictionaries into every fork that signs a user
 * up, and holds them for the life of the process. Multiplied by the slots
 * vitest opens, that was enough memory and GC pressure to start failing
 * unrelated files — including the worker suite, on its own database. The
 * password policy's own suite sets this back to a real floor.
 */
process.env.PASSWORD_MIN_SCORE ??= '0'

/** Long enough for Better Auth's own check; every file needs one, none needs its own. */
process.env.BETTER_AUTH_SECRET ??= 'test-secret-that-is-at-least-32-characters-long!'

beforeAll(prepareTestDatabase)
