/**
 * Receive the one file of a multipart request as a stream, without holding it.
 *
 * `Request.formData()` and Hono's `parseBody()` read the whole body into
 * memory before handing anything back, so a 100MB upload — which the size cap
 * allows — costs the web task 100MB of heap at once, and a task sized for
 * serving pages goes down with it. Here the body is parsed as it arrives and
 * the file's bytes go straight to the consumer.
 */

import busboy from 'busboy'
import { Readable, Transform } from 'node:stream'
import { PayloadTooLargeError, ValidationError } from '@kukan/shared'

export interface MultipartFile {
  filename: string
  contentType: string
  /** The file's bytes as they arrive. The consumer has to read them to the end. */
  stream: Readable
}

export interface MultipartFileOptions {
  /** The form field the file is expected under. */
  field: string
  /** Bytes the file itself may reach. A file of exactly this size is accepted. */
  maxFileSize: number
  /** What the 413 says the cap is, in the caller's words. */
  limitMessage: string
}

/**
 * What the request may carry beyond the file: boundaries, part headers, and
 * whatever other fields the client sends alongside.
 *
 * The file cap alone bounds nothing at the request level — `limits.fileSize`
 * is per part, so a body of a hundred parts just under it is a hundred times
 * the cap, and with no `Content-Length` nothing was reading the total.
 * Generous, because it is a guard rather than a contract: the envelope for one
 * part is a few hundred bytes, and the number here only has to be obviously
 * above every honest use before it is worth refusing on.
 */
const REQUEST_OVERHEAD_ALLOWANCE = 1024 * 1024

/**
 * Parse `request` as multipart and hand the `field` file to `use` as soon as
 * its headers have arrived.
 *
 * `use` must consume the stream (storing it is the point) and settles with
 * whatever it made of the file. The byte count is known only once the stream
 * has ended — after `use` has read it — so it comes back beside the result.
 *
 * Two caps, and 413 on either. The file's own, which is the contract; and the
 * whole request's, which is the file's plus {@link REQUEST_OVERHEAD_ALLOWANCE}.
 * Both are checked up front against `Content-Length` where the client sent
 * one, and on the bytes as they arrive either way. A refusal closes the body
 * and destroys the file stream, so neither the parser nor the consumer spends
 * anything more on a request already turned down.
 */
export async function receiveMultipartFile<T>(
  request: Request,
  opts: MultipartFileOptions,
  use: (file: MultipartFile) => Promise<T>
): Promise<{ result: T; size: number }> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new ValidationError('Expected multipart/form-data')
  }
  const maxBodySize = opts.maxFileSize + REQUEST_OVERHEAD_ALLOWANCE
  // Against the request's cap, not the file's: the declared length counts the
  // boundaries and headers too, so comparing it with the file cap would refuse
  // a file of exactly the size the cap allows.
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBodySize) throw new PayloadTooLargeError(opts.limitMessage)
  if (!request.body) throw new ValidationError('Missing request body')

  const body = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])

  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      // Both ends: the body stops arriving, and the parser stops waiting for
      // the rest of a form it will never be handed. Repeated calls are
      // harmless — destroy is idempotent and a settled promise ignores them.
      body.destroy()
      parser.destroy()
      reject(err)
    }

    // No `files` limit: it counts every file part, so a file under another
    // name ahead of the wanted one would have the wanted one dropped. Files
    // this does not want are drained instead, and the request cap below is
    // what bounds how much of them there can be.
    //
    // One over the file cap, because busboy raises `limit` on reaching the
    // size rather than passing it: at `fileSize` exactly, a file of precisely
    // the cap is delivered in full and still flagged as over.
    const parser = busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: opts.maxFileSize + 1 },
    })
    let taken: Promise<{ result: T; size: number }> | null = null

    parser.on('file', (name, stream, info) => {
      if (name !== opts.field || taken) {
        // Absorbed, not reported: a part nobody asked for is destroyed along
        // with the parser when the request is refused, and an error on a
        // stream with no listener would take the process down over a failure
        // already being reported.
        stream.on('error', () => {})
        stream.resume()
        return
      }
      // Counted on the way through rather than with a `data` listener of our
      // own, which would put the stream into flowing mode beside the consumer.
      let size = 0
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          callback(null, chunk)
        },
      })
      // The consumer may not be listening by the time this is destroyed: when
      // it is the consumer that failed, its own rejection tears the parser
      // down, and busboy destroys the file part on the way out — an error
      // arriving at a stream nobody reads is an uncaught exception, and the
      // web task goes down over an S3 failure it was already reporting. A
      // consumer that *is* reading still receives it: this listener absorbs,
      // it does not intercept.
      counted.on('error', () => {})
      const stopWith = (err: Error) => {
        counted.destroy(err)
        fail(err)
      }
      stream.on('limit', () => stopWith(new PayloadTooLargeError(opts.limitMessage)))
      // busboy destroys the file stream when the form ends mid-part, which a
      // client hanging up produces. `pipe` does not carry an error across, so
      // without this the stream emits it with nobody listening and the process
      // goes down with an uncaught `Unexpected end of form`.
      stream.on('error', stopWith)
      stream.pipe(counted)

      taken = use({ filename: info.filename, contentType: info.mimeType, stream: counted }).then(
        (result) => ({ result, size })
      )
      taken.catch(fail)
    })
    parser.on('error', fail)
    parser.on('close', () => {
      if (!taken) fail(new ValidationError(`Missing "${opts.field}" field in multipart form data`))
      else taken.then(resolve, fail)
    })

    // The request's own cap, ahead of the parser: `limits.fileSize` bounds one
    // part, and a body with no `Content-Length` has as many parts as it likes.
    let bodyBytes = 0
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bodyBytes += chunk.length
        if (bodyBytes > maxBodySize) callback(new PayloadTooLargeError(opts.limitMessage))
        else callback(null, chunk)
      },
    })
    bounded.on('error', fail)

    body.on('error', fail)
    body.pipe(bounded).pipe(parser)
  })
}
