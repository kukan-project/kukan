/**
 * Scale presets (small / medium / large), their deep-merged overrides, and the
 * database sizing the multi-site connection budget reads.
 */

import type { DbEngine, DeepPartial, Scale, ScaleComputed } from './types.js'

/** RDS instance class shape, `db.<family>.<size>` — the DatabaseConstruct strips
 *  the prefix and hands the rest to EC2 InstanceType, so anything else would
 *  synthesize into a CloudFormation error at deploy time. */
const RDS_INSTANCE_CLASS_PATTERN = /^db\.[a-z0-9]+\.[a-z0-9]+$/

/** The rds engine's class when a preset (medium/large default to Aurora) or the
 *  operator names none. */
export const RDS_DEFAULT_INSTANCE_CLASS = 'db.t4g.micro'

/** RDS memory decomposes as size × family: sizes are GiB for the t/m families
 *  (large = 8); r doubles that, and the x generations differ from each other
 *  (x2g.large 32 GiB, x2iedn.xlarge 128 GiB), so they are listed by name. */
const RDS_SIZE_GIB: Record<string, number> = {
  micro: 1,
  small: 2,
  medium: 4,
  large: 8,
  xlarge: 16,
  '2xlarge': 32,
  '4xlarge': 64,
  '8xlarge': 128,
  '12xlarge': 192,
  '16xlarge': 256,
  '24xlarge': 384,
}

const RDS_FAMILY_MEMORY_FACTOR: Record<string, number> = {
  t: 1,
  m: 1,
  r: 2,
  x2g: 4,
  x2idn: 4,
  x2iedn: 8,
  x2iezn: 8,
}

/** The rds instance class — computeScaled guarantees it for the rds engine. */
export function rdsInstanceClass(db: ScaleComputed['db']): string {
  if (!db.instanceClass) {
    throw new Error(
      'db.instanceClass is unset for the rds engine (computeScaled should have filled it)'
    )
  }
  return db.instanceClass
}

/** Memory of an RDS class in GiB, or a synth error for a shape the connection
 *  budget cannot size — better than quietly budgeting it as a micro. */
function rdsInstanceMemoryGib(instanceClass: string): number {
  const [, family = '', size = ''] = instanceClass.split('.')
  const gib = RDS_SIZE_GIB[size]
  // t/m/r keep their ratio across generations (t4g, m6g, r7g…); x is per name
  const factor = RDS_FAMILY_MEMORY_FACTOR[family] ?? RDS_FAMILY_MEMORY_FACTOR[family.charAt(0)]
  if (
    gib === undefined ||
    factor === undefined ||
    (family.startsWith('x') && !(family in RDS_FAMILY_MEMORY_FACTOR))
  ) {
    throw new Error(
      `db.instanceClass "${instanceClass}" is not a known RDS class shape (families t*/m*/r*/` +
        `${Object.keys(RDS_FAMILY_MEMORY_FACTOR)
          .filter((f) => f.length > 1)
          .join('/')}, ` +
        `sizes ${Object.keys(RDS_SIZE_GIB).join('/')}) — the connection budget cannot size it`
    )
  }
  return gib * factor
}

/**
 * AWS-documented default max_connections for Aurora PostgreSQL Serverless v2
 * by maximum ACU ("Maximum connections for Aurora serverless" table). Held
 * constant regardless of the current ACU. The raw LEAST(memory/9531392, 5000)
 * formula overestimates (it ignores the instance memory overhead), so the
 * budget interpolates between these anchors instead.
 */
const AURORA_MAX_CONNECTIONS: ReadonlyArray<readonly [maxAcu: number, connections: number]> = [
  [1, 189],
  [4, 823],
  [8, 1669],
  [16, 3360],
  [32, 5000],
]

/** The most connections Aurora allows at any capacity (the table's last anchor). */
export const AURORA_MAX_CONNECTIONS_CEILING =
  AURORA_MAX_CONNECTIONS[AURORA_MAX_CONNECTIONS.length - 1][1]

/** Estimated max_connections of the shared database (see AURORA_MAX_CONNECTIONS).
 *  The rds engine preset is db.t4g.micro (1 GiB → ~112 by the raw formula).
 *  `uncappedConnections` is the value before the PostgreSQL rule that a
 *  minimum capacity of 0 or 0.5 ACUs caps max_connections at 2,000 — the
 *  remedy compares the required connections against both bounds to tell
 *  which ACU knob (minAcu, maxAcu, or both) actually helps. */
export function estimateMaxConnections(db: ScaleComputed['db']): {
  connections: number
  uncappedConnections: number
} {
  if (db.engine !== 'aurora') {
    // RDS PostgreSQL default: LEAST({DBInstanceClassMemory/9531392}, 5000)
    const gib = rdsInstanceMemoryGib(rdsInstanceClass(db))
    const connections = Math.min(Math.floor((gib * 1024 ** 3) / 9_531_392), 5000)
    return { connections, uncappedConnections: connections }
  }
  const maxAcu = db.maxAcu ?? 2
  const [firstAcu, firstConns] = AURORA_MAX_CONNECTIONS[0]
  const [lastAcu, lastConns] = AURORA_MAX_CONNECTIONS[AURORA_MAX_CONNECTIONS.length - 1]
  let connections: number
  if (maxAcu <= firstAcu) {
    connections = Math.floor((firstConns * maxAcu) / firstAcu)
  } else if (maxAcu >= lastAcu) {
    connections = lastConns
  } else {
    const upper = AURORA_MAX_CONNECTIONS.findIndex(([acu]) => acu >= maxAcu)
    const [a0, c0] = AURORA_MAX_CONNECTIONS[upper - 1]
    const [a1, c1] = AURORA_MAX_CONNECTIONS[upper]
    connections = Math.floor(c0 + ((c1 - c0) * (maxAcu - a0)) / (a1 - a0))
  }
  const capped = (db.minAcu ?? 0) <= 0.5 && connections > 2000
  return { connections: capped ? 2000 : connections, uncappedConnections: connections }
}

const SCALE_DEFAULTS: Record<Scale, ScaleComputed> = {
  small: {
    web: { cpu: 256, memory: 512, minSize: 1, maxSize: 2 },
    worker: { cpu: 256, memory: 1024, minTasks: 1, maxTasks: 2, healthPort: 8080 },
    db: { engine: 'rds', instanceClass: RDS_DEFAULT_INSTANCE_CLASS, multiAz: false },
    opensearch: {
      instanceType: 't3.small.search',
      instanceCount: 1,
      volumeSize: 10,
      multiAz: false,
      indexReplicas: 0,
    },
    // The worker's 5: the least one task needs (apps/worker/src/concurrency.ts)
    dbPool: { webMax: 5, workerMax: 5 },
    backup: {
      s3Versioning: false,
      s3NoncurrentVersionExpirationDays: 30,
      dbBackupRetentionDays: 7,
      awsBackup: false,
    },
  },
  medium: {
    web: { cpu: 512, memory: 1024, minSize: 1, maxSize: 5 },
    worker: { cpu: 512, memory: 1024, minTasks: 1, maxTasks: 2, healthPort: 8080 },
    db: { engine: 'aurora', minAcu: 0.5, maxAcu: 2, multiAz: false },
    opensearch: {
      instanceType: 'm6g.large.search',
      instanceCount: 1,
      volumeSize: 50,
      multiAz: false,
      indexReplicas: 0,
    },
    dbPool: { webMax: 10, workerMax: 5 },
    backup: {
      s3Versioning: true,
      s3NoncurrentVersionExpirationDays: 30,
      dbBackupRetentionDays: 14,
      awsBackup: false,
    },
  },
  large: {
    web: { cpu: 1024, memory: 2048, minSize: 2, maxSize: 10 },
    worker: { cpu: 1024, memory: 2048, minTasks: 2, maxTasks: 5, healthPort: 8080 },
    db: { engine: 'aurora', minAcu: 2, maxAcu: 8, multiAz: true },
    opensearch: {
      instanceType: 'm6g.xlarge.search',
      instanceCount: 2,
      volumeSize: 100,
      multiAz: true,
      indexReplicas: 1,
    },
    dbPool: { webMax: 20, workerMax: 10 },
    backup: {
      s3Versioning: true,
      s3NoncurrentVersionExpirationDays: 30,
      dbBackupRetentionDays: 35,
      awsBackup: { dailyRetentionDays: 35, monthlyRetentionMonths: 12 },
    },
  },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge `override` onto `base` (arrays and primitives replace; objects merge).
 *  Key presence decides, so an explicit `undefined` unsets — SiteConfig.bedrock
 *  documents that as how one site opts out of a model the environment names. */
export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!override) return base
  const result = { ...base } as Record<string, unknown>
  for (const key of Object.keys(override)) {
    const o = (override as Record<string, unknown>)[key]
    const b = (base as Record<string, unknown>)[key]
    result[key] = isPlainObject(o) && isPlainObject(b) ? deepMerge(b, o) : o
  }
  return result as T
}

/**
 * Scale preset + overrides + db engine/ACU resolution — shared by loadConfig
 * and the multi-site connection budget (validateSites) so the two can never
 * disagree on the numbers.
 */
export function computeScaled(
  scale: Scale,
  dbEngine: DbEngine | undefined,
  overrides?: DeepPartial<ScaleComputed>
): ScaleComputed {
  const computed = deepMerge<ScaleComputed>(SCALE_DEFAULTS[scale], overrides)
  const db = { ...computed.db, engine: dbEngine ?? computed.db.engine }
  if (db.engine === 'aurora' && db.minAcu == null) {
    db.minAcu = 0
    db.maxAcu = 2
  }
  if (db.engine === 'rds') {
    // The medium/large presets carry no class (they default to Aurora)
    db.instanceClass ??= RDS_DEFAULT_INSTANCE_CLASS
    if (!RDS_INSTANCE_CLASS_PATTERN.test(db.instanceClass)) {
      throw new Error(
        `db.instanceClass "${db.instanceClass}" must look like db.<family>.<size> (e.g. db.t4g.small)`
      )
    }
    rdsInstanceMemoryGib(db.instanceClass) // a shape the connection budget can size
  }
  return { ...computed, db }
}
