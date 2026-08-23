import { useEffect, useState, useCallback, useRef } from 'react'
import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundles } from '@duckdb/duckdb-wasm'
import { clientFetch } from '@/lib/client-api'
import { parquetFileName, buildQuery } from './duckdb-sql'
import { formatCell } from '@/lib/format-utils'

type ArrowTable = Awaited<ReturnType<AsyncDuckDBConnection['query']>>

// --- Types ---

export interface ColumnFilter {
  column: string
  operator: 'eq' | 'neq' | 'contains' | 'starts_with' | 'ends_with'
  value: string
}

export interface SortState {
  column: string
  direction: 'ASC' | 'DESC'
}

export interface DuckDBQueryParams {
  sort?: SortState
  filters?: ColumnFilter[]
  searchKeyword?: string
  page: number
  pageSize: number
}

interface UseDuckDBOptions {
  resourceId: string
  enabled: boolean
}

interface UseDuckDBResult {
  ready: boolean
  loading: boolean
  queryLoading: boolean
  error: string | null
  columns: string[]
  totalRows: number
  filteredRows: number
  rows: Record<string, string>[]
  query: (params: DuckDBQueryParams) => Promise<void>
}

// --- Singleton DuckDB instance ---

let dbInstance: AsyncDuckDB | null = null
let dbInitPromise: Promise<AsyncDuckDB> | null = null

async function getDB(): Promise<AsyncDuckDB> {
  if (dbInstance) return dbInstance
  if (dbInitPromise) return dbInitPromise

  dbInitPromise = (async () => {
    const duckdb = await import('@duckdb/duckdb-wasm')

    // Emitted as build assets rather than copied into `public/`, so the 79 MB
    // these four files weigh gets what every other asset already has: a
    // content-hashed name under `/_next/static/`, `immutable` caching, and a
    // 404 that Next marks `no-store`.
    //
    // Served from `public/` none of that holds. The path is fixed, so it cannot
    // be immutable without pinning stale bytes; and a URL for a version the
    // container never shipped — ordinary during a rolling deploy — falls to the
    // catch-all page, which answers 200 with HTML. Under an `immutable` header
    // that answer is what the edge and every browser keep, for a year.
    const bundles: DuckDBBundles = {
      mvp: {
        mainModule: new URL('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm', import.meta.url).href,
        mainWorker: new URL(
          '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js',
          import.meta.url
        ).href,
      },
      eh: {
        mainModule: new URL('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', import.meta.url).href,
        mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url)
          .href,
      },
    }

    const bundle = await duckdb.selectBundle(bundles)
    const worker = new Worker(bundle.mainWorker!)
    const logger = new duckdb.ConsoleLogger()
    const db = new duckdb.AsyncDuckDB(logger, worker)
    await db.instantiate(bundle.mainModule)

    dbInstance = db
    return db
  })().catch((err) => {
    // Allow retry on next call if WASM loading fails (e.g. network hiccup)
    dbInitPromise = null
    throw err
  })

  return dbInitPromise
}

// --- SQL helpers ---

/** Arrow type ids for the temporal columns (apache-arrow `Type.Date` / `Type.Timestamp`). */
const ARROW_DATE = 8
const ARROW_TIMESTAMP = 10

/**
 * Arrow rows as display strings. Shares `formatCell` with the hyparquet preview:
 * both read the same Parquet, and a column typed one way must not read two ways
 * on screen (ADR-046 gave the preview real DATE and TIMESTAMP columns).
 *
 * Arrow hands DATE and TIMESTAMP values back as epoch milliseconds, not `Date`,
 * so left alone they would render as raw numbers where the hyparquet reader
 * shows `2026-08-23 12:00:00`. Rebuilt into `Date` here so `formatCell` reads
 * them the one way.
 */
function arrowToStringRows(result: ArrowTable, columns: string[]): Record<string, string>[] {
  const temporal = new Set(
    result.schema.fields
      .filter((f) => f.typeId === ARROW_DATE || f.typeId === ARROW_TIMESTAMP)
      .map((f) => f.name)
  )
  return result.toArray().map((row: Record<string, unknown>) => {
    const obj: Record<string, string> = {}
    for (const col of columns) {
      const value = row[col]
      obj[col] =
        temporal.has(col) && typeof value === 'number'
          ? formatCell(new Date(value))
          : formatCell(value)
    }
    return obj
  })
}

// --- Hook ---

export function useDuckDB({ resourceId, enabled }: UseDuckDBOptions): UseDuckDBResult {
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [queryLoading, setQueryLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [columns, setColumns] = useState<string[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [filteredRows, setFilteredRows] = useState(0)
  const [rows, setRows] = useState<Record<string, string>[]>([])

  const connRef = useRef<AsyncDuckDBConnection | null>(null)
  const fileNameRef = useRef<string>('')
  const queryIdRef = useRef(0)

  // Initialize DuckDB and load Parquet file
  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const abortController = new AbortController()
    const fileName = parquetFileName(resourceId)

    async function init() {
      try {
        setLoading(true)
        setError(null)

        const db = await getDB()
        if (cancelled) return

        // Close stale connection from previous mount
        try {
          await connRef.current?.close()
        } catch {
          // ignore
        }
        connRef.current = null

        if (cancelled) return

        // Fetch and register Parquet file
        const url = `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`
        const res = await clientFetch(url, { signal: abortController.signal })
        if (!res.ok) {
          throw new Error(res.status === 404 ? 'Preview not available' : `HTTP ${res.status}`)
        }
        const buffer = await res.arrayBuffer()
        if (cancelled) return

        const bytes = new Uint8Array(buffer)

        // Validate Parquet magic bytes (PAR1)
        if (
          bytes.length < 4 ||
          bytes[0] !== 0x50 ||
          bytes[1] !== 0x41 ||
          bytes[2] !== 0x52 ||
          bytes[3] !== 0x31
        ) {
          throw new Error('Preview is not a valid Parquet file')
        }

        await db.dropFile(fileName).catch(() => {})
        await db.registerFileBuffer(fileName, bytes)
        fileNameRef.current = fileName
        if (cancelled) {
          db.dropFile(fileName).catch(() => {})
          fileNameRef.current = ''
          return
        }

        // Connect and query first page + count
        const conn = await db.connect()
        if (cancelled) {
          await conn.close().catch(() => {})
          return
        }
        connRef.current = conn

        const [dataResult, countResult] = await Promise.all([
          conn.query(`SELECT * FROM '${fileName}' LIMIT 100`),
          conn.query(`SELECT COUNT(*) AS cnt FROM '${fileName}'`),
        ])
        if (cancelled) return

        const cols = dataResult.schema.fields.map((f) => f.name)
        const total = Number(countResult.toArray()[0].cnt)

        setColumns(cols)
        setTotalRows(total)
        setFilteredRows(total)
        setRows(arrowToStringRows(dataResult, cols))
        setReady(true)
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to initialize DuckDB'
          if (!message.includes('abort')) {
            setError(message)
          }
          setLoading(false)
        }
      }
    }

    init()
    return () => {
      cancelled = true
      abortController.abort()
      try {
        connRef.current?.close().catch(() => {})
      } catch {
        // ignore
      }
      connRef.current = null
      // Drop file to free WASM heap — fileNameRef is instance-local,
      // so a new instance can't reuse it anyway
      if (fileNameRef.current) {
        dbInstance?.dropFile(fileNameRef.current).catch(() => {})
        fileNameRef.current = ''
      }
    }
  }, [resourceId, enabled])

  const query = useCallback(
    async (params: DuckDBQueryParams) => {
      if (!connRef.current || columns.length === 0) return

      const id = ++queryIdRef.current

      try {
        setQueryLoading(true)
        setError(null)
        const conn = connRef.current
        const { dataSQL, countSQL } = buildQuery(fileNameRef.current, columns, params)

        const [dataResult, countResult] = await Promise.all([
          conn.query(dataSQL),
          conn.query(countSQL),
        ])

        // Discard stale results if a newer query was issued
        if (id !== queryIdRef.current) return

        setRows(arrowToStringRows(dataResult, columns))
        setFilteredRows(Number(countResult.toArray()[0].cnt))
      } catch (err) {
        if (id !== queryIdRef.current) return
        setError(err instanceof Error ? err.message : 'Query failed')
      } finally {
        if (id === queryIdRef.current) {
          setQueryLoading(false)
        }
      }
    },
    [columns]
  )

  return {
    ready,
    loading,
    queryLoading,
    error,
    columns,
    totalRows,
    filteredRows,
    rows,
    query,
  }
}
