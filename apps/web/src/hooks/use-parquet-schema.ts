import { useEffect, useState } from 'react'
import type { FileMetaData, SchemaElement } from 'hyparquet'

/** Semantic field type, decoupled from the Parquet physical/logical type. */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime'

export interface ParquetField {
  name: string
  /** Semantic type, derived from the Parquet logical/physical type. Currently
   * always 'string' (the writer emits every column as STRING → BYTE_ARRAY/UTF8);
   * the other branches activate once type inference (ADR-016) lands. */
  type: FieldType
  /** Parquet physical (storage) type, e.g. BYTE_ARRAY, INT64. null if absent. */
  physicalType: string | null
  /** Parquet logical/converted type (semantic annotation), e.g. UTF8/STRING,
   * DATE. null when the column has no logical annotation (raw physical type). */
  logicalType: string | null
  /** Whether the column may contain nulls (REQUIRED → false). The writer
   * currently emits every column as OPTIONAL, so this is true for now. */
  nullable: boolean
  /** On-disk (compressed) size of the column in bytes, summed across row groups.
   * Note: hyparquet-writer 0.15.6 does not populate total_uncompressed_size
   * (it duplicates the compressed size), so only the compressed size is exposed. */
  compressedSize: number
}

interface UseParquetSchemaResult {
  fields: ParquetField[] | null
  loading: boolean
  error: string | null
}

/** Logical type, preferring converted_type, then logical_type; null if neither. */
function logicalTypeLabel(el: SchemaElement): string | null {
  if (el.converted_type) return el.converted_type
  if (el.logical_type) return el.logical_type.type
  return null
}

/**
 * Maps a Parquet leaf schema element to a semantic field type.
 * The writer currently emits BYTE_ARRAY/UTF8 (STRING) for every column, so this
 * resolves to 'string' today; the other branches are ready for typed columns.
 */
function mapFieldType(el: SchemaElement): FieldType {
  const conv = el.converted_type
  if (conv === 'DATE') return 'date'
  if (conv === 'TIMESTAMP_MILLIS' || conv === 'TIMESTAMP_MICROS') return 'datetime'
  if (conv === 'UTF8' || conv === 'JSON' || conv === 'BSON' || conv === 'ENUM') return 'string'

  switch (el.type) {
    case 'BOOLEAN':
      return 'boolean'
    case 'INT32':
    case 'INT64':
    case 'INT96':
      return 'integer'
    case 'FLOAT':
    case 'DOUBLE':
      return 'number'
    default:
      return 'string'
  }
}

/**
 * Sums each column's compressed (on-disk) size in bytes across all row groups.
 * For the flat schemas the writer produces, a column chunk's path_in_schema is
 * a single-element array holding the column name.
 */
function columnByteSizes(meta: FileMetaData): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const rg of meta.row_groups) {
    for (const col of rg.columns) {
      const md = col.meta_data
      if (!md) continue
      const name = md.path_in_schema[0]
      if (!name) continue
      sizes.set(name, (sizes.get(name) ?? 0) + Number(md.total_compressed_size))
    }
  }
  return sizes
}

/**
 * Reads only the Parquet footer (schema + row count + per-column sizes) via the
 * server-proxied preview endpoint. Does NOT download row data —
 * `parquetMetadataAsync` issues a Range Read for the footer only, so this is
 * cheap enough to render alongside the resource metadata.
 */
export function useParquetSchema(resourceId: string): UseParquetSchemaResult {
  const [fields, setFields] = useState<ParquetField[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)

        const proxyUrl = `/api/v1/resources/${encodeURIComponent(resourceId)}/preview`
        const { asyncBufferFromUrl, parquetMetadataAsync } = await import('hyparquet')

        let file
        try {
          file = await asyncBufferFromUrl({ url: proxyUrl })
        } catch {
          // 404 or network error — no Parquet preview for this resource
          if (!cancelled) setLoading(false)
          return
        }

        const meta = await parquetMetadataAsync(file)
        if (cancelled) return

        const sizes = columnByteSizes(meta)
        // Leaf schema elements (no children) are the actual columns
        const leaves = meta.schema.filter((s) => !s.num_children)
        setFields(
          leaves.map((s) => ({
            name: s.name,
            type: mapFieldType(s),
            physicalType: s.type ?? null,
            logicalType: logicalTypeLabel(s),
            nullable: s.repetition_type !== 'REQUIRED',
            compressedSize: sizes.get(s.name) ?? 0,
          }))
        )
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load schema')
          setLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  return { fields, loading, error }
}
