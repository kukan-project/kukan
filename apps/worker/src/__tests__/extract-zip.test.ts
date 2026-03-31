import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { extractZipManifest } from '../pipeline/steps/extract-zip'

async function createTestZip(
  files: { name: string; content?: string; dir?: boolean }[]
): Promise<Buffer> {
  const zip = new JSZip()
  for (const file of files) {
    if (file.dir) {
      zip.folder(file.name)
    } else {
      zip.file(file.name, file.content ?? '')
    }
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  return buf
}

/**
 * Create a minimal valid ZIP with a single empty file,
 * allowing control over raw filename bytes and general purpose bit flags.
 * Used to test Shift_JIS vs UTF-8 filename decoding.
 */
function createRawZip(filenameBytes: Buffer, flags: number): Buffer {
  const fnLen = filenameBytes.length

  // Local file header
  const local = Buffer.alloc(30 + fnLen)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0x0021, 12) // DOS date: 1980-01-01
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(0, 18)
  local.writeUInt32LE(0, 22)
  local.writeUInt16LE(fnLen, 26)
  local.writeUInt16LE(0, 28)
  filenameBytes.copy(local, 30)

  // Central directory header
  const central = Buffer.alloc(46 + fnLen)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0x0021, 14) // DOS date: 1980-01-01
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(0, 20)
  central.writeUInt32LE(0, 24)
  central.writeUInt16LE(fnLen, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(0, 42)
  filenameBytes.copy(central, 46)

  // End of central directory record
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + fnLen, 12)
  eocd.writeUInt32LE(30 + fnLen, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([local, central, eocd])
}

describe('extractZipManifest', () => {
  it('should extract file listing from a valid ZIP', async () => {
    const buffer = await createTestZip([
      { name: 'data.csv', content: 'a,b,c\n1,2,3' },
      { name: 'readme.txt', content: 'hello' },
    ])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.totalFiles).toBe(2)
    expect(manifest!.truncated).toBe(false)
    expect(manifest!.entries).toHaveLength(2)

    const csvEntry = manifest!.entries.find((e) => e.path === 'data.csv')
    expect(csvEntry).toBeDefined()
    expect(csvEntry!.isDirectory).toBe(false)
    expect(csvEntry!.size).toBeGreaterThan(0)
    expect(csvEntry!.lastModified).toBeTruthy()
  })

  it('should handle directories', async () => {
    const buffer = await createTestZip([
      { name: 'folder/', dir: true },
      { name: 'folder/file.txt', content: 'inside folder' },
    ])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.totalFiles).toBe(1) // directory excluded from count
    expect(manifest!.entries).toHaveLength(2) // but included in entries
    const dirEntry = manifest!.entries.find((e) => e.path === 'folder/')
    expect(dirEntry).toBeDefined()
    expect(dirEntry!.isDirectory).toBe(true)
  })

  it('should handle empty ZIP', async () => {
    const buffer = await createTestZip([])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.totalFiles).toBe(0)
    expect(manifest!.entries).toHaveLength(0)
    expect(manifest!.truncated).toBe(false)
  })

  it('should return null for invalid data', async () => {
    const buffer = Buffer.from('this is not a zip file')

    const manifest = await extractZipManifest(buffer)

    expect(manifest).toBeNull()
  })

  it('should calculate total sizes correctly', async () => {
    const content = 'x'.repeat(1000)
    const buffer = await createTestZip([
      { name: 'a.txt', content },
      { name: 'b.txt', content },
    ])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.totalSize).toBe(2000)
    expect(manifest!.totalCompressed).toBeGreaterThan(0)
  })

  it('should handle deeply nested directories', async () => {
    const buffer = await createTestZip([
      { name: 'a/', dir: true },
      { name: 'a/b/', dir: true },
      { name: 'a/b/c/', dir: true },
      { name: 'a/b/c/deep.txt', content: 'deep file' },
      { name: 'root.txt', content: 'top level' },
    ])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.totalFiles).toBe(2) // only deep.txt and root.txt
    expect(manifest!.entries).toHaveLength(5)

    const deepFile = manifest!.entries.find((e) => e.path === 'a/b/c/deep.txt')
    expect(deepFile).toBeDefined()
    expect(deepFile!.isDirectory).toBe(false)
    expect(deepFile!.size).toBeGreaterThan(0)

    const dirB = manifest!.entries.find((e) => e.path === 'a/b/')
    expect(dirB).toBeDefined()
    expect(dirB!.isDirectory).toBe(true)
    expect(dirB!.size).toBe(0)
  })

  it('should produce timezone-free lastModified strings (no Z suffix)', async () => {
    const buffer = await createTestZip([{ name: 'file.txt', content: 'test' }])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    const entry = manifest!.entries[0]
    expect(entry.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(entry.lastModified).not.toContain('Z')
  })

  it('should decode Shift_JIS file names when UTF-8 flag is not set', async () => {
    const Encoding = (await import('encoding-japanese')).default
    const sjisBytes = Encoding.convert(Encoding.stringToCode('テスト.txt'), {
      to: 'SJIS',
      from: 'UNICODE',
    })
    const buffer = createRawZip(Buffer.from(sjisBytes), 0)

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.entries[0].path).toBe('テスト.txt')
  })

  it('should decode UTF-8 file names when UTF-8 flag is set', async () => {
    const utf8Buf = Buffer.from('日本語ファイル.txt', 'utf-8')
    const buffer = createRawZip(utf8Buf, 0x800)

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.entries[0].path).toBe('日本語ファイル.txt')
  })

  it('should decode UTF-8 file names even without UTF-8 flag', async () => {
    const utf8Buf = Buffer.from('données.txt', 'utf-8')
    const buffer = createRawZip(utf8Buf, 0) // no UTF-8 flag

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.entries[0].path).toBe('données.txt')
  })

  it('should handle zero-size files', async () => {
    const buffer = await createTestZip([{ name: 'empty.txt', content: '' }])

    const manifest = await extractZipManifest(buffer)

    expect(manifest).not.toBeNull()
    expect(manifest!.entries[0].size).toBe(0)
    expect(manifest!.entries[0].compressedSize).toBe(0)
    expect(manifest!.totalSize).toBe(0)
  })

  describe('file path input', () => {
    let tmpDir: string

    afterEach(async () => {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    })

    it('should extract manifest from a file path', async () => {
      const buffer = await createTestZip([
        { name: 'data.csv', content: 'a,b,c\n1,2,3' },
        { name: 'readme.txt', content: 'hello' },
      ])
      tmpDir = await mkdtemp(join(tmpdir(), 'kukan-test-'))
      const filePath = join(tmpDir, 'test.zip')
      await writeFile(filePath, buffer)

      const manifest = await extractZipManifest(filePath)

      expect(manifest).not.toBeNull()
      expect(manifest!.totalFiles).toBe(2)
      expect(manifest!.entries).toHaveLength(2)
    })

    it('should return null for non-existent file path', async () => {
      const manifest = await extractZipManifest('/tmp/non-existent-file.zip')

      expect(manifest).toBeNull()
    })
  })
})
