// Signed request to an IamAuth Web Function endpoint (SigV4, service "lambda").
// usage: node call.mjs <https-url> [METHOD] [body]  — credentials, and COOKIE, from the environment
// (call.sh exports them). The payload is declared UNSIGNED-PAYLOAD, which Lambda accepts.
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(process.env.SIGV4_MODULE)
const { SignatureV4 } = require('@smithy/signature-v4')

class Sha256 {
  constructor(secret) {
    this.h = secret ? createHmac('sha256', secret) : createHash('sha256')
  }
  update(data) {
    this.h.update(data)
  }
  async digest() {
    return new Uint8Array(this.h.digest())
  }
}

const [url, method = 'GET', body] = process.argv.slice(2)
const u = new URL(url)
const signer = new SignatureV4({
  service: 'lambda',
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  sha256: Sha256,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
})
const headers = { host: u.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }
if (body) headers['content-type'] = 'application/json'
// A session (COOKIE) and the Origin Better Auth checks on writes
if (process.env.COOKIE) headers.cookie = process.env.COOKIE
if (method !== 'GET') headers.origin = u.origin
const signed = await signer.sign({
  method,
  protocol: 'https:',
  hostname: u.host,
  path: u.pathname,
  query: Object.fromEntries(u.searchParams),
  headers,
  body,
})
const t0 = performance.now()
const res = await fetch(url, { method, headers: signed.headers, body, redirect: 'manual' })
const text = await res.text()
const ms = Math.round(performance.now() - t0)
console.error(
  `${method} ${u.pathname}${u.search} status=${res.status} ms=${ms} bytes=${text.length}`
)
for (const h of [
  'content-type',
  'location',
  'lambda-web-error-type',
  'x-nextjs-cache',
  'cache-control',
])
  if (res.headers.get(h)) console.error(`  ${h}: ${res.headers.get(h)}`)
for (const c of res.headers.getSetCookie()) console.error(`  set-cookie: ${c.split(';')[0]}`)
process.stdout.write(text)
