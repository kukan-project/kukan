import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useParquetSchema } from '../use-parquet-schema'

// Mock hyparquet
const mockAsyncBufferFromUrl = vi.fn()
const mockParquetMetadataAsync = vi.fn()

vi.mock('hyparquet', () => ({
  asyncBufferFromUrl: (...args: unknown[]) => mockAsyncBufferFromUrl(...args),
  parquetMetadataAsync: (...args: unknown[]) => mockParquetMetadataAsync(...args),
}))

const fakeFile = { byteLength: 1000, slice: vi.fn() }

/** Build minimal FileMetaData with the given leaf schema elements and per-column compressed sizes. */
function buildMeta(
  leaves: Record<string, unknown>[],
  sizesByRowGroup: Record<string, bigint>[] = []
) {
  return {
    num_rows: 100n,
    schema: [{ name: 'root', num_children: leaves.length }, ...leaves],
    row_groups: sizesByRowGroup.map((sizes) => ({
      columns: Object.entries(sizes).map(([name, total]) => ({
        meta_data: { path_in_schema: [name], total_compressed_size: total },
      })),
    })),
  }
}

describe('useParquetSchema', () => {
  beforeEach(() => {
    mockAsyncBufferFromUrl.mockReset()
    mockParquetMetadataAsync.mockReset()
    mockAsyncBufferFromUrl.mockResolvedValue(fakeFile)
  })

  it('extracts string columns (the current writer output: BYTE_ARRAY/UTF8/OPTIONAL)', async () => {
    mockParquetMetadataAsync.mockResolvedValue(
      buildMeta(
        [
          { name: 'pref', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' },
          { name: 'pop', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' },
        ],
        [{ pref: 101n, pop: 71n }]
      )
    )

    const { result } = renderHook(() => useParquetSchema('r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.fields).toEqual([
      {
        name: 'pref',
        type: 'string',
        physicalType: 'BYTE_ARRAY',
        logicalType: 'UTF8',
        nullable: true,
        compressedSize: 101,
      },
      {
        name: 'pop',
        type: 'string',
        physicalType: 'BYTE_ARRAY',
        logicalType: 'UTF8',
        nullable: true,
        compressedSize: 71,
      },
    ])
    expect(mockAsyncBufferFromUrl).toHaveBeenCalledWith({ url: '/api/v1/resources/r1/preview' })
  })

  it('maps physical/logical types to semantic field types', async () => {
    mockParquetMetadataAsync.mockResolvedValue(
      buildMeta([
        { name: 'a', type: 'INT64', repetition_type: 'OPTIONAL' }, // integer (no logical)
        { name: 'b', type: 'DOUBLE', repetition_type: 'OPTIONAL' }, // number
        { name: 'c', type: 'BOOLEAN', repetition_type: 'OPTIONAL' }, // boolean
        { name: 'd', type: 'INT32', converted_type: 'DATE', repetition_type: 'OPTIONAL' }, // date
        {
          name: 'e',
          type: 'INT64',
          converted_type: 'TIMESTAMP_MILLIS',
          repetition_type: 'OPTIONAL',
        }, // datetime
        { name: 'f', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' }, // string (BYTE_ARRAY, no logical)
      ])
    )

    const { result } = renderHook(() => useParquetSchema('r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.fields?.map((f) => f.type)).toEqual([
      'integer',
      'number',
      'boolean',
      'date',
      'datetime',
      'string',
    ])
  })

  it('derives nullable from repetition_type and logicalType from logical_type fallback', async () => {
    mockParquetMetadataAsync.mockResolvedValue(
      buildMeta([
        { name: 'req', type: 'INT64', repetition_type: 'REQUIRED' },
        { name: 'opt', type: 'BYTE_ARRAY', logical_type: { type: 'STRING' } },
      ])
    )

    const { result } = renderHook(() => useParquetSchema('r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const [req, opt] = result.current.fields!
    expect(req.nullable).toBe(false) // REQUIRED
    expect(req.logicalType).toBeNull() // no converted_type / logical_type
    expect(opt.nullable).toBe(true) // missing repetition_type → not REQUIRED
    expect(opt.logicalType).toBe('STRING') // from logical_type.type
  })

  it('sums compressed size across multiple row groups', async () => {
    mockParquetMetadataAsync.mockResolvedValue(
      buildMeta(
        [{ name: 'x', type: 'BYTE_ARRAY', converted_type: 'UTF8' }],
        [{ x: 100n }, { x: 55n }]
      )
    )

    const { result } = renderHook(() => useParquetSchema('r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.fields?.[0].compressedSize).toBe(155)
  })

  it('returns null fields (no error) when preview is unavailable (404)', async () => {
    mockAsyncBufferFromUrl.mockRejectedValue(new Error('404'))

    const { result } = renderHook(() => useParquetSchema('r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.fields).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('surfaces an error when metadata parsing fails', async () => {
    mockParquetMetadataAsync.mockRejectedValue(new Error('corrupt footer'))

    const { result } = renderHook(() => useParquetSchema('r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.fields).toBeNull()
    expect(result.current.error).toBe('corrupt footer')
  })
})
