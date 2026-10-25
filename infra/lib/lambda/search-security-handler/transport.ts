/**
 * SigV4-signed HTTPS to the OpenSearch domain, as the Lambda's execution role
 * (the domain's master user). aws4 rather than the OpenSearch client: a few
 * calls to the security API need no more, and it bundles to one small file.
 */

import { request } from 'node:https'
import aws4 from 'aws4'

export interface SignedResponse {
  status: number
  body: string
}

export function signedRequest(
  host: string,
  method: 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<SignedResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  // Credentials come from the Lambda environment (AWS_ACCESS_KEY_ID, ...),
  // which aws4 reads by default
  const signed = aws4.sign({
    host,
    method,
    path,
    service: 'es',
    region: process.env.AWS_REGION,
    headers: payload ? { 'Content-Type': 'application/json' } : {},
    body: payload,
  })
  return new Promise((resolve, reject) => {
    const req = request({ ...signed, host, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      )
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`Timed out: ${method} ${path}`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
