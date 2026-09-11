import { describe, it, expect, vi } from 'vitest'
import { PayloadTooLargeError, ValidationError } from '@kukan/shared'
import { receiveMultipartFile, type MultipartFile } from '../../streams/multipart-file'

/**
 * The bytes a client would send for this form, and the header naming their
 * boundary.
 *
 * Materialized rather than handed to `Request` as a `FormData`: undici streams
 * a form body in lazily, and a request cancelled early — which every refusal
 * here does — leaves it enqueueing into a stream that has closed, as an
 * unhandled `ERR_INVALID_STATE`. A real request's body is the socket, with no
 * such generator behind it.
 */
async function multipartBody(form: FormData): Promise<{ contentType: string; bytes: ArrayBuffer }> {
  const encoded = new Request('http://test/upload', { method: 'POST', body: form })
  return {
    contentType: encoded.headers.get('content-type')!,
    bytes: await encoded.arrayBuffer(),
  }
}

async function multipartRequest(
  form: FormData,
  headers: Record<string, string> = {}
): Promise<Request> {
  const { contentType, bytes } = await multipartBody(form)
  return new Request('http://test/upload', {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body: bytes,
  })
}

/** The same body with no Content-Length, which is what a chunked client sends. */
async function chunkedRequest(form: FormData): Promise<Request> {
  const { contentType, bytes } = await multipartBody(form)
  const view = new Uint8Array(bytes)
  const body = new ReadableStream({
    start(controller) {
      for (let at = 0; at < view.length; at += 16 * 1024) {
        controller.enqueue(view.subarray(at, at + 16 * 1024))
      }
      controller.close()
    },
  })
  return new Request('http://test/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    duplex: 'half',
  } as RequestInit)
}

/** Read the file to the end, the way a storage upload does. */
async function drain(file: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of file.stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const opts = { field: 'file', maxFileSize: 1024 * 1024, limitMessage: 'too large' }

describe('receiveMultipartFile', () => {
  it('hands the file over as a stream and counts its bytes', async () => {
    const content = Buffer.alloc(300_000, 'x')
    const form = new FormData()
    form.append('note', 'ignored')
    form.append('file', new File([content], 'data.csv', { type: 'text/csv' }))

    const { result, size } = await receiveMultipartFile(
      await multipartRequest(form),
      opts,
      async (file) => ({
        filename: file.filename,
        contentType: file.contentType,
        body: await drain(file),
      })
    )

    expect(result.filename).toBe('data.csv')
    expect(result.contentType).toBe('text/csv')
    expect(result.body.equals(content)).toBe(true)
    expect(size).toBe(content.length)
  })

  it('refuses a body the client declares over the cap before reading it', async () => {
    const form = new FormData()
    form.append('file', new File(['small'], 'a.csv'))
    const use = vi.fn()

    await expect(
      receiveMultipartFile(
        await multipartRequest(form, {
          'content-length': String(opts.maxFileSize + 2 * 1024 * 1024),
        }),
        opts,
        use
      )
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(use).not.toHaveBeenCalled()
  })

  it('refuses a file that runs over the cap as it arrives, and stops the consumer', async () => {
    // The consumer's stream ends in an error rather than a truncated file it
    // could mistake for the whole.
    const form = new FormData()
    form.append('file', new File([Buffer.alloc(4096, 'x')], 'big.csv'))
    let consumerSettled: Promise<unknown> | undefined

    await expect(
      receiveMultipartFile(await multipartRequest(form), { ...opts, maxFileSize: 1024 }, (file) => {
        const read = drain(file)
        consumerSettled = read.catch((err: unknown) => err)
        return read
      })
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
    // Awaited rather than read: the refusal reaches the caller first now, so
    // the consumer is still unwinding when the request is already refused.
    await expect(consumerSettled).resolves.toBeInstanceOf(PayloadTooLargeError)
  })

  it('rejects a request with no file in the field', async () => {
    const form = new FormData()
    form.append('other', 'value')
    const use = vi.fn()

    await expect(
      receiveMultipartFile(await multipartRequest(form), opts, use)
    ).rejects.toBeInstanceOf(ValidationError)
    expect(use).not.toHaveBeenCalled()
  })

  it('rejects a body that is not multipart', async () => {
    const request = new Request('http://test/upload', {
      method: 'POST',
      body: JSON.stringify({ file: 'x' }),
      headers: { 'content-type': 'application/json' },
    })

    await expect(receiveMultipartFile(request, opts, vi.fn())).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('takes the named field and lets other files pass by', async () => {
    const form = new FormData()
    form.append('thumbnail', new File(['png'], 'thumb.png', { type: 'image/png' }))
    form.append('file', new File(['a,b'], 'data.csv', { type: 'text/csv' }))

    const { result } = await receiveMultipartFile(
      await multipartRequest(form),
      opts,
      async (file) => ({
        filename: file.filename,
        body: (await drain(file)).toString(),
      })
    )

    expect(result).toEqual({ filename: 'data.csv', body: 'a,b' })
  })

  it('accepts a file of exactly the cap', async () => {
    // busboy raises `limit` on reaching the size rather than passing it, so a
    // cap set to the contract's number refuses the size the contract allows.
    const content = Buffer.alloc(1024, 'x')
    const form = new FormData()
    form.append('file', new File([content], 'exact.csv'))

    const { size } = await receiveMultipartFile(
      await multipartRequest(form),
      { ...opts, maxFileSize: content.length },
      (file) => drain(file)
    )

    expect(size).toBe(content.length)
  })

  it('refuses a request whose parts add up past the cap, each of them under it', async () => {
    // `limits.fileSize` bounds one part. Without a cap on the request, a body
    // of many parts just under it is many times the cap, and with no
    // Content-Length nothing was counting.
    const form = new FormData()
    for (let i = 0; i < 40; i++) {
      form.append(`junk${i}`, new File([Buffer.alloc(100 * 1024, 'y')], `j${i}.bin`))
    }
    form.append('file', new File(['a,b'], 'data.csv'))

    await expect(
      receiveMultipartFile(
        await chunkedRequest(form),
        { ...opts, maxFileSize: 512 * 1024 },
        (file) => drain(file)
      )
    ).rejects.toBeInstanceOf(PayloadTooLargeError)
  })

  it('refuses a form that ends mid-file rather than taking the process down', async () => {
    // What a client hanging up mid-upload produces. busboy destroys the file
    // stream, and `pipe` does not carry that across — unlistened, it is an
    // uncaught `Unexpected end of form`.
    const boundary = 'cut0ff'
    const truncated = new Request('http://test/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body:
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\n' +
        'col1,col2\r\na,b',
    })

    await expect(receiveMultipartFile(truncated, opts, (file) => drain(file))).rejects.toThrow(
      /Unexpected end of form/
    )
  })

  // Both of these also guard against an uncaught exception: the consumer's
  // rejection tears the parser down, and busboy destroys the file part on the
  // way out. Vitest fails the run on an unhandled error, so a clean run is the
  // assertion — it is what a storage outage must not cost the web task.
  it('surfaces the consumer failing before it reads anything', async () => {
    const form = new FormData()
    form.append('file', new File(['a,b'], 'data.csv'))

    await expect(
      receiveMultipartFile(await multipartRequest(form), opts, async () => {
        throw new Error('bucket unreachable')
      })
    ).rejects.toThrow('bucket unreachable')
  })

  it('surfaces the consumer failing partway through the file', async () => {
    // What an S3 upload does when the transfer breaks: some of the file has
    // gone, and the rest is still arriving.
    const form = new FormData()
    form.append('file', new File([Buffer.alloc(256 * 1024, 'x')], 'data.csv'))

    await expect(
      receiveMultipartFile(await multipartRequest(form), opts, async (file) => {
        for await (const _chunk of file.stream) throw new Error('connection reset')
      })
    ).rejects.toThrow('connection reset')
  })
})
