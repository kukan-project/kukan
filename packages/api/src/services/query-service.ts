/**
 * KUKAN Query Service (ADR-032 Part B)
 *
 * Runs a read-only SQL query against a resource's preview Parquet. Access, limits, and
 * temp-file cleanup live here so the route and MCP tool stay thin.
 */

import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { ValidationError, createLogger, type Logger } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { ResourceService } from './resource-service'
import { PipelineService, isQueryable } from './pipeline-service'
import type { AuthUser } from '../auth/permissions'
import { runSandboxedQuery } from './query/duckdb-sandbox'
import { assertReadOnlySql } from './query/sql-guard'
import { withDuckdbSlot } from './query/semaphore'
import {
  QUERY_MAX_ROWS,
  QUERY_MAX_BYTES,
  QUERY_TIMEOUT_MS,
  QUERY_MEMORY_LIMIT_MB,
  QUERY_THREADS,
  QUERY_MAX_SQL_LENGTH,
} from '../config'

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
}

export class QueryService {
  private readonly log: Logger

  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
    logger?: Logger
  ) {
    this.log = logger ?? createLogger({ name: 'api' })
  }

  /**
   * Execute `sql` against the resource's preview Parquet (queryable as table `data`).
   * Throws NotFoundError (visibility), ValidationError (not queryable / bad SQL /
   * timeout), or TooManyRequestsError (concurrency).
   *
   * `signal` is the request's own, where there is one: a query whose caller hung
   * up stops and gives up the shared DuckDB slot instead of running to the end
   * for nobody.
   */
  async query(
    resourceId: string,
    sql: string,
    user?: AuthUser,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    // Validate the SQL before any expensive work (download + DuckDB materialize). The REST
    // route bounds length via zValidator, but the MCP tool does not — enforce both here.
    if (sql.length > QUERY_MAX_SQL_LENGTH) {
      throw new ValidationError(`SQL query exceeds the maximum length of ${QUERY_MAX_SQL_LENGTH}`)
    }
    assertReadOnlySql(sql)

    // Visibility check (private resources require org membership — ADR-017).
    await new ResourceService(this.db).getByIdWithAccessCheck(resourceId, user)

    // Resolve the preview Parquet + validated schema in one read.
    const target = await new PipelineService(this.db).getQueryTarget(resourceId)
    if (!isQueryable(target)) {
      throw new ValidationError(
        'Resource is not queryable: no tabular preview is available (only processed CSV/TSV resources can be queried)'
      )
    }

    const previewKey = target.previewKey

    // Bound concurrency to keep total DuckDB memory within the container.
    return withDuckdbSlot(async () => {
      const tmpPath = join(tmpdir(), `kukan-query-${randomUUID()}.parquet`)
      const startedAt = Date.now()
      try {
        const source = await this.storage.download(previewKey)
        await pipeline(source, createWriteStream(tmpPath))

        const result = await runSandboxedQuery(tmpPath, sql, {
          maxRows: QUERY_MAX_ROWS,
          maxBytes: QUERY_MAX_BYTES,
          timeoutMs: QUERY_TIMEOUT_MS,
          memoryLimitMb: QUERY_MEMORY_LIMIT_MB,
          threads: QUERY_THREADS,
          signal,
        })

        const elapsedMs = Date.now() - startedAt
        this.log.info(
          {
            component: 'query',
            resourceId,
            sql,
            elapsedMs,
            rowCount: result.rowCount,
            truncated: result.truncated,
          },
          'resource query'
        )
        return { ...result, elapsedMs }
      } finally {
        await unlink(tmpPath).catch(() => {})
      }
    }, signal)
  }
}
