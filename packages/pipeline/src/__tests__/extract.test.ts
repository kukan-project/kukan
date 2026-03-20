import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFile, unlink, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractStep } from '../steps/extract'
import type { PipelineContext } from '../types'

function createMockCtx() {
  return {
    storage: {
      download: vi.fn(),
      upload: vi.fn(),
    },
    search: {
      index: vi.fn(),
    },
    getResource: vi.fn(),
    updateResourceHash: vi.fn(),
    getPackageForIndex: vi.fn(),
  } satisfies PipelineContext
}

describe('extractStep', () => {
  let tmpDir: string
  let ctx: ReturnType<typeof createMockCtx>

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kukan-test-'))
    ctx = createMockCtx()
  })

  afterEach(async () => {
    // cleanup handled by individual tests
  })

  it('should extract CSV and upload Parquet to storage', async () => {
    const tmpFile = join(tmpDir, 'test.csv')
    await writeFile(tmpFile, 'name,age\nAlice,30\nBob,25\n')

    const result = await extractStep('res-1', 'pkg-1', tmpFile, 'CSV', ctx)
    await unlink(tmpFile)

    expect(result).toBe('previews/pkg-1/res-1.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()

    const [key, buf, meta] = ctx.storage.upload.mock.calls[0]
    expect(key).toBe('previews/pkg-1/res-1.parquet')
    expect(meta).toEqual({ contentType: 'application/vnd.apache.parquet' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
  })

  it('should handle title row skipping in Parquet output', async () => {
    const csv = 'Title Row,,,\n\nname,age,city\nAlice,30,Tokyo\n'
    const tmpFile = join(tmpDir, 'test.csv')
    await writeFile(tmpFile, csv)

    const result = await extractStep('res-2', 'pkg-1', tmpFile, 'CSV', ctx)
    await unlink(tmpFile)

    expect(result).toBe('previews/pkg-1/res-2.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should extract TSV data', async () => {
    const tmpFile = join(tmpDir, 'test.tsv')
    await writeFile(tmpFile, 'name\tage\nAlice\t30\n')

    const result = await extractStep('res-3', 'pkg-1', tmpFile, 'TSV', ctx)
    await unlink(tmpFile)

    expect(result).toBe('previews/pkg-1/res-3.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should store all rows without truncation', async () => {
    const lines = ['name,value']
    for (let i = 0; i < 300; i++) {
      lines.push(`row-${i},${i}`)
    }
    const tmpFile = join(tmpDir, 'big.csv')
    await writeFile(tmpFile, lines.join('\n') + '\n')

    const result = await extractStep('res-4', 'pkg-1', tmpFile, 'CSV', ctx)
    await unlink(tmpFile)

    // Parquet stores all rows (no 200-row limit)
    expect(result).toBe('previews/pkg-1/res-4.parquet')
    expect(ctx.storage.upload).toHaveBeenCalledOnce()
  })

  it('should return null for unsupported formats', async () => {
    const result = await extractStep('res-5', 'pkg-1', '/dev/null', 'PDF', ctx)
    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return null for null format', async () => {
    const result = await extractStep('res-6', 'pkg-1', '/dev/null', null, ctx)
    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })

  it('should return null for empty CSV (no headers after parsing)', async () => {
    const tmpFile = join(tmpDir, 'empty.csv')
    await writeFile(tmpFile, '')

    const result = await extractStep('res-7', 'pkg-1', tmpFile, 'CSV', ctx)
    await unlink(tmpFile)

    expect(result).toBeNull()
    expect(ctx.storage.upload).not.toHaveBeenCalled()
  })
})
