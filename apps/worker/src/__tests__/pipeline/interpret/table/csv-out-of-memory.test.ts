import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretCsv } from '@/pipeline/interpret/table/csv'

// A memory bound small enough to reach in a unit test; a file of its own so the
// other CSV tests keep the real one. The spill cap settles the same way
// (`isOutOfMemory`), but a CSV's reading runs out of memory long before it
// spills much, so it cannot be reached here quickly.
vi.mock('@/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config')>()),
  INTERPRET_MEMORY_LIMIT_MB: 16,
  INTERPRET_THREADS: 1,
}))

describe('interpretCsv — out of memory', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-csv-oom-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('settles as out-of-memory rather than failing the run', async () => {
    const lines = ['id,a,b']
    for (let i = 0; i < 300_000; i++) {
      const h = createHash('md5').update(String(i)).digest('hex')
      lines.push(`${i},${h},${h}${i}`)
    }
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, lines.join('\n'))

    const result = await interpretCsv(csvPath, join(dir, 'out.parquet'))

    expect(result.reason).toBe('out-of-memory')
    expect(existsSync(join(dir, 'out.parquet'))).toBe(false)
  })
})
