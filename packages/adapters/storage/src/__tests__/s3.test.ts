import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'
import { S3StorageAdapter } from '../s3'

// Mock @aws-sdk/client-s3
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: mockSend }
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'PutObject' }
  }),
  GetObjectCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'GetObject' }
  }),
  DeleteObjectCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'DeleteObject' }
  }),
  ListObjectsV2Command: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'ListObjectsV2' }
  }),
  DeleteObjectsCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input, _type: 'DeleteObjects' }
  }),
}))

// Mock @aws-sdk/lib-storage
const mockUploadDone = vi.fn()
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(function () {
    return { done: mockUploadDone }
  }),
}))

// Mock @aws-sdk/s3-request-presigner
const mockGetSignedUrl = vi.fn()
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}))

describe('S3StorageAdapter', () => {
  let storage: S3StorageAdapter

  beforeEach(() => {
    mockSend.mockReset()
    mockUploadDone.mockReset()
    mockGetSignedUrl.mockReset()
    storage = new S3StorageAdapter({
      bucket: 'test-bucket',
      region: 'ap-northeast-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    })
  })

  describe('upload', () => {
    it('should upload Buffer with PutObjectCommand', async () => {
      mockSend.mockResolvedValue({})
      const body = Buffer.from('hello')

      await storage.upload('test/key.txt', body, { contentType: 'text/plain' })

      expect(mockSend).toHaveBeenCalledTimes(1)
      const cmd = mockSend.mock.calls[0][0]
      expect(cmd._type).toBe('PutObject')
      expect(cmd.input.Bucket).toBe('test-bucket')
      expect(cmd.input.Key).toBe('test/key.txt')
      expect(cmd.input.Body).toBe(body)
      expect(cmd.input.ContentType).toBe('text/plain')
      expect(cmd.input.ContentLength).toBe(5)
    })

    it('should upload Readable stream with multipart Upload', async () => {
      mockUploadDone.mockResolvedValue({})
      const stream = Readable.from(['stream data'])

      await storage.upload('test/stream.txt', stream)

      expect(mockUploadDone).toHaveBeenCalledTimes(1)
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('should include metadata when originalFilename is provided', async () => {
      mockSend.mockResolvedValue({})
      const body = Buffer.from('data')

      await storage.upload('key', body, { originalFilename: 'report.csv' })

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.Metadata).toEqual({ 'original-filename': 'report.csv' })
    })

    it('should not include Metadata field when no meta is provided', async () => {
      mockSend.mockResolvedValue({})

      await storage.upload('key', Buffer.from('data'))

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.Metadata).toBeUndefined()
    })
  })

  describe('download', () => {
    it('should return response Body as Readable', async () => {
      const mockBody = Readable.from(['file content'])
      mockSend.mockResolvedValue({ Body: mockBody })

      const result = await storage.download('test/key.txt')

      expect(result).toBe(mockBody)
      const cmd = mockSend.mock.calls[0][0]
      expect(cmd._type).toBe('GetObject')
      expect(cmd.input.Bucket).toBe('test-bucket')
      expect(cmd.input.Key).toBe('test/key.txt')
    })
  })

  describe('delete', () => {
    it('should send DeleteObjectCommand', async () => {
      mockSend.mockResolvedValue({})

      await storage.delete('test/key.txt')

      expect(mockSend).toHaveBeenCalledTimes(1)
      const cmd = mockSend.mock.calls[0][0]
      expect(cmd._type).toBe('DeleteObject')
      expect(cmd.input.Bucket).toBe('test-bucket')
      expect(cmd.input.Key).toBe('test/key.txt')
    })
  })

  describe('downloadRange', () => {
    it('should send GetObjectCommand with Range header', async () => {
      const mockBody = Readable.from(['partial'])
      mockSend.mockResolvedValue({
        Body: mockBody,
        ContentRange: 'bytes 0-99/1000',
        ContentLength: 100,
      })

      const result = await storage.downloadRange('key', 0, 99)

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.Range).toBe('bytes=0-99')
      expect(result.stream).toBe(mockBody)
      expect(result.totalSize).toBe(1000)
      expect(result.start).toBe(0)
      expect(result.end).toBe(99)
    })

    it('should clamp end to totalSize - 1', async () => {
      mockSend.mockResolvedValue({
        Body: Readable.from(['']),
        ContentRange: 'bytes 0-499/200',
      })

      const result = await storage.downloadRange('key', 0, 499)

      expect(result.end).toBe(199)
    })

    it('should fall back to ContentLength when ContentRange is absent', async () => {
      mockSend.mockResolvedValue({
        Body: Readable.from(['']),
        ContentLength: 500,
      })

      const result = await storage.downloadRange('key', 0, 99)

      expect(result.totalSize).toBe(500)
    })
  })

  describe('getSignedUrl', () => {
    it('should generate presigned URL with default expiry', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url')

      const url = await storage.getSignedUrl('test/key.txt')

      expect(url).toBe('https://signed-url')
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1)

      const [, cmd, opts] = mockGetSignedUrl.mock.calls[0]
      expect(cmd._type).toBe('GetObject')
      expect(cmd.input.Key).toBe('test/key.txt')
      expect(opts.expiresIn).toBe(3600)
    })

    it('should set inline Content-Disposition', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url')

      await storage.getSignedUrl('key', { inline: true })

      const [, cmd] = mockGetSignedUrl.mock.calls[0]
      expect(cmd.input.ResponseContentDisposition).toBe('inline')
    })

    it('should set attachment Content-Disposition with filename', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url')

      await storage.getSignedUrl('key', { filename: 'データ.csv' })

      const [, cmd] = mockGetSignedUrl.mock.calls[0]
      expect(cmd.input.ResponseContentDisposition).toContain('attachment')
      expect(cmd.input.ResponseContentDisposition).toContain(encodeURIComponent('データ.csv'))
    })

    it('should set ResponseContentType when contentType is provided', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url')

      await storage.getSignedUrl('key', { contentType: 'text/csv' })

      const [, cmd] = mockGetSignedUrl.mock.calls[0]
      expect(cmd.input.ResponseContentType).toBe('text/csv')
    })

    it('should use custom expiresIn', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed-url')

      await storage.getSignedUrl('key', { expiresIn: 600 })

      const [, , opts] = mockGetSignedUrl.mock.calls[0]
      expect(opts.expiresIn).toBe(600)
    })
  })

  describe('getSignedUploadUrl', () => {
    it('should generate presigned PUT URL', async () => {
      mockGetSignedUrl.mockResolvedValue('https://upload-url')

      const url = await storage.getSignedUploadUrl('uploads/file.csv', 'text/csv')

      expect(url).toBe('https://upload-url')
      const [, cmd, opts] = mockGetSignedUrl.mock.calls[0]
      expect(cmd._type).toBe('PutObject')
      expect(cmd.input.Key).toBe('uploads/file.csv')
      expect(cmd.input.ContentType).toBe('text/csv')
      expect(opts.expiresIn).toBe(3600)
    })

    it('should include metadata when originalFilename is provided', async () => {
      mockGetSignedUrl.mockResolvedValue('https://upload-url')

      await storage.getSignedUploadUrl('key', 'text/csv', 3600, {
        originalFilename: 'report.csv',
      })

      const [, cmd] = mockGetSignedUrl.mock.calls[0]
      expect(cmd.input.Metadata).toEqual({ 'original-filename': 'report.csv' })
    })

    it('should use custom expiresIn', async () => {
      mockGetSignedUrl.mockResolvedValue('https://upload-url')

      await storage.getSignedUploadUrl('key', 'text/csv', 900)

      const [, , opts] = mockGetSignedUrl.mock.calls[0]
      expect(opts.expiresIn).toBe(900)
    })
  })

  describe('deleteByPrefix', () => {
    it('should list and batch-delete objects matching prefix', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'prefix/a.txt' }, { Key: 'prefix/b.txt' }],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({ Errors: undefined })

      const deleted = await storage.deleteByPrefix('prefix/')

      expect(deleted).toBe(2)
      expect(mockSend).toHaveBeenCalledTimes(2)

      const listCmd = mockSend.mock.calls[0][0]
      expect(listCmd._type).toBe('ListObjectsV2')
      expect(listCmd.input.Bucket).toBe('test-bucket')
      expect(listCmd.input.Prefix).toBe('prefix/')

      const deleteCmd = mockSend.mock.calls[1][0]
      expect(deleteCmd._type).toBe('DeleteObjects')
      expect(deleteCmd.input.Bucket).toBe('test-bucket')
      expect(deleteCmd.input.Delete.Objects).toEqual([
        { Key: 'prefix/a.txt' },
        { Key: 'prefix/b.txt' },
      ])
    })

    it('should return 0 when no objects match prefix', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: undefined,
        IsTruncated: false,
      })

      const deleted = await storage.deleteByPrefix('empty/')

      expect(deleted).toBe(0)
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('should handle pagination with continuation tokens', async () => {
      mockSend
        // First page
        .mockResolvedValueOnce({
          Contents: [{ Key: 'prefix/a.txt' }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        })
        .mockResolvedValueOnce({ Errors: undefined }) // delete first batch
        // Second page
        .mockResolvedValueOnce({
          Contents: [{ Key: 'prefix/b.txt' }],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({ Errors: undefined }) // delete second batch

      const deleted = await storage.deleteByPrefix('prefix/')

      expect(deleted).toBe(2)
      expect(mockSend).toHaveBeenCalledTimes(4)

      // Second list call should include ContinuationToken
      const secondListCmd = mockSend.mock.calls[2][0]
      expect(secondListCmd._type).toBe('ListObjectsV2')
      expect(secondListCmd.input.ContinuationToken).toBe('token-1')
    })

    it('should throw when DeleteObjects returns errors', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'prefix/a.txt' }],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Errors: [{ Key: 'prefix/a.txt', Code: 'AccessDenied' }],
        })

      await expect(storage.deleteByPrefix('prefix/')).rejects.toThrow(
        'Failed to delete 1 objects'
      )
    })
  })

  describe('downloadRange', () => {
    it('should send GetObjectCommand with Range header', async () => {
      const { Readable } = await import('stream')
      const mockStream = new Readable({ read() { this.push(null) } })
      mockSend.mockResolvedValue({
        Body: mockStream,
        ContentRange: 'bytes 0-99/500',
        ContentLength: 100,
      })

      const result = await storage.downloadRange('files/doc.pdf', 0, 99)

      const cmd = mockSend.mock.calls[0][0]
      expect(cmd.input.Bucket).toBe('test-bucket')
      expect(cmd.input.Key).toBe('files/doc.pdf')
      expect(cmd.input.Range).toBe('bytes=0-99')
      expect(result.totalSize).toBe(500)
      expect(result.start).toBe(0)
      expect(result.end).toBe(99)
    })

    it('should fall back to ContentLength when ContentRange is absent', async () => {
      const { Readable } = await import('stream')
      const mockStream = new Readable({ read() { this.push(null) } })
      mockSend.mockResolvedValue({
        Body: mockStream,
        ContentLength: 200,
      })

      const result = await storage.downloadRange('files/small.txt', 0, 199)

      expect(result.totalSize).toBe(200)
    })
  })
})
