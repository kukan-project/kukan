/** A file over the limit, as against one that failed to arrive. */
export class TooLarge extends Error {}

/**
 * A response's body, read as it arrives and cancelled once past `limit`: a
 * Content-Length is not there to be believed, nor always there.
 */
export async function readUpTo(res: Response, limit: number): Promise<ArrayBuffer> {
  if (!res.body) throw new Error('no body')
  if (Number(res.headers.get('content-length')) > limit) throw new TooLarge()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new TooLarge()
    }
    chunks.push(value)
  }
  return new Blob(chunks).arrayBuffer()
}
