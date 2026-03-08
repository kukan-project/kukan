import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { Readable } from 'stream'
import { LocalStorageAdapter } from '../local'

describe('LocalStorageAdapter', () => {
  let adapter: LocalStorageAdapter
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kukan-storage-test-'))
    adapter = new LocalStorageAdapter({ basePath: tempDir })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('upload', () => {
    it('should write Buffer to filesystem', async () => {
      const data = Buffer.from('hello world')
      await adapter.upload('test.txt', data)

      const content = await readFile(join(tempDir, 'test.txt'), 'utf-8')
      expect(content).toBe('hello world')
    })

    it('should write Readable stream to filesystem', async () => {
      const stream = Readable.from(['hello', ' ', 'stream'])
      await adapter.upload('stream.txt', stream)

      const content = await readFile(join(tempDir, 'stream.txt'), 'utf-8')
      expect(content).toBe('hello stream')
    })

    it('should create directories recursively', async () => {
      const data = Buffer.from('nested')
      await adapter.upload('a/b/c/file.txt', data)

      const content = await readFile(join(tempDir, 'a/b/c/file.txt'), 'utf-8')
      expect(content).toBe('nested')
    })
  })

  describe('download', () => {
    it('should return readable stream for existing file', async () => {
      await adapter.upload('test.txt', Buffer.from('download me'))

      const stream = await adapter.download('test.txt')
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
      }
      expect(Buffer.concat(chunks).toString()).toBe('download me')
    })

    it('should throw for non-existent file', async () => {
      const stream = await adapter.download('missing.txt')
      await expect(async () => {
        for await (const _ of stream) {
          // consume
        }
      }).rejects.toThrow()
    })
  })

  describe('delete', () => {
    it('should remove file from filesystem', async () => {
      await adapter.upload('to-delete.txt', Buffer.from('bye'))
      await adapter.delete('to-delete.txt')

      await expect(readFile(join(tempDir, 'to-delete.txt'))).rejects.toThrow()
    })
  })

  describe('getSignedUrl', () => {
    it('should return file:// URL', async () => {
      const url = await adapter.getSignedUrl('test.txt')
      expect(url).toBe(`file://${join(tempDir, 'test.txt')}`)
    })
  })
})
