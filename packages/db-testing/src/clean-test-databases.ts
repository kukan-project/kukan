/**
 * Drop every test database nothing is using.
 *
 * A run reclaims what earlier runs left behind when it starts, so this is not
 * needed for the suite to keep working. It exists for the two cases that path
 * does not cover: a machine whose next run is not coming soon, and the
 * databases the old one-per-suite scheme left behind, which the sweep will
 * never match because they are not named for a run.
 *
 * Live runs are protected the same way they are during a sweep — by the
 * advisory lock they hold — so this is safe to run while someone else is
 * testing.
 */
import { cleanTestDatabases } from './index'

const { dropped, kept } = await cleanTestDatabases()
process.stdout.write(
  dropped.length === 0
    ? `Nothing to drop${kept.length > 0 ? `; ${kept.length} in use` : ''}\n`
    : `Dropped ${dropped.length}: ${dropped.join(', ')}\n`
)
