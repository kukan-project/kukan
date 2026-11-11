import { Writable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { createLogger, LOG_REDACT_PATHS, serializeLogError } from '../logger'

/** A logger with the redactions, and the lines it writes. */
function capture() {
  const lines: string[] = []
  const log = pino(
    { redact: LOG_REDACT_PATHS, serializers: { err: serializeLogError } },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
  )
  return { log, lines }
}

describe('LOG_REDACT_PATHS', () => {
  it('censors credentials at the top level, one level down and in request headers', () => {
    const { log, lines } = capture()
    log.info({
      password: 'secret-password-0',
      'x-kukan-api-key': 'secret-token-2',
      'x-ckan-api-key': 'secret-token-3',
      user: { email: 'a@example.com', password: 'secret-password-1' },
      headers: {
        authorization: 'Bearer secret-token-0',
        cookie: 'secret-cookie-0',
        'x-kukan-api-key': 'secret-token-4',
        'x-ckan-api-key': 'secret-token-5',
      },
      req: {
        method: 'GET',
        headers: {
          authorization: 'Bearer secret-token-1',
          cookie: 'secret-cookie-1',
          'x-kukan-api-key': 'secret-token-6',
          'x-ckan-api-key': 'secret-token-7',
        },
      },
    })
    const line = JSON.parse(lines[0])
    expect(line.password).toBe('[Redacted]')
    expect(line['x-kukan-api-key']).toBe('[Redacted]')
    expect(line['x-ckan-api-key']).toBe('[Redacted]')
    expect(line.user).toEqual({ email: 'a@example.com', password: '[Redacted]' })
    const headers = {
      authorization: '[Redacted]',
      cookie: '[Redacted]',
      'x-kukan-api-key': '[Redacted]',
      'x-ckan-api-key': '[Redacted]',
    }
    expect(line.headers).toEqual(headers)
    expect(line.req).toEqual({ method: 'GET', headers })
    expect(lines[0]).not.toContain('secret-')
  })

  it("censors the headers an SDK's error carries", () => {
    const { log, lines } = capture()
    const err = Object.assign(new Error('429 Rate limit'), {
      status: 429,
      headers: { 'openai-organization': 'secret-org-0' },
    })
    log.warn({ err }, 'completion failed')
    const line = JSON.parse(lines[0])
    expect(line.err).toMatchObject({
      message: '429 Rate limit',
      status: 429,
      headers: '[Redacted]',
    })
    expect(lines[0]).not.toContain('secret-')
  })
})

describe('serializeLogError', () => {
  it('bounds a message that carries a whole response body, in the stack too', () => {
    const { log, lines } = capture()
    const body = 'material-excerpt '.repeat(250)
    log.warn({ err: new Error(`400 ${body}`) }, 'completion failed')
    const line = JSON.parse(lines[0])
    expect(line.err.message.length).toBeLessThanOrEqual(1_001)
    expect(line.err.message.endsWith('…')).toBe(true)
    expect(line.err.stack.startsWith(`Error: ${line.err.message}\n`)).toBe(true)
    // The message once at 1,000 and again at the head of a stack held to 4,000
    expect(lines[0].length).toBeLessThan(5_500)
  })

  it("leaves out the AWS SDK's raw response", () => {
    const { log, lines } = capture()
    const err = Object.assign(new Error('Deserialization error'), {
      $metadata: { httpStatusCode: 500, requestId: 'req-1' },
      $response: { headers: { 'x-amzn-requestid': 'req-1' }, body: 'secret-body-0' },
      $responseBodyText: 'secret-body-1',
    })
    log.error({ err }, 'completion failed')
    const line = JSON.parse(lines[0])
    expect(line.err.$metadata).toEqual({ httpStatusCode: 500, requestId: 'req-1' })
    expect(line.err).not.toHaveProperty('$response')
    expect(lines[0]).not.toContain('secret-')
  })

  it('bounds the errors pino serializes inside one, and drops their raw responses', () => {
    const { log, lines } = capture()
    const big = 'X'.repeat(20_000)
    const err = new AggregateError([new Error(big)], 'aggregate')
    Object.assign(err, {
      original: Object.assign(new Error(big), { $response: { body: 'secret-body-2' } }),
    })
    log.error({ err }, 'completion failed')
    expect(lines[0].length).toBeLessThan(8_000)
    expect(lines[0]).not.toContain('secret-')
  })

  it("bounds the response body an SDK keeps on the error, keeping a short one's shape", () => {
    const { log, lines } = capture()
    const long = Object.assign(new Error('400 Bad request'), {
      error: { message: 'material-excerpt '.repeat(1_300) },
    })
    log.error({ err: long }, 'completion failed')
    expect(lines[0].length).toBeLessThan(6_500)
    const short = Object.assign(new Error('400 Bad request'), {
      error: { type: 'invalid_request_error' },
    })
    log.error({ err: short }, 'completion failed')
    expect(JSON.parse(lines[1]).err.error).toEqual({ type: 'invalid_request_error' })
    // The error itself is left as it was
    expect(short.error).toEqual({ type: 'invalid_request_error' })
  })

  it('passes a value that is not an error through', () => {
    expect(serializeLogError('just text')).toBe('just text')
  })

  it('keeps the line when a field cannot be written as JSON as it stands', () => {
    const { log, lines } = capture()
    const response: Record<string, unknown> = { status: 502 }
    response.self = response
    const err = Object.assign(new Error('upstream failed'), {
      response,
      empty: { toJSON: () => undefined },
    })
    Object.defineProperty(err, 'stack', { value: 12345 })
    log.error({ err }, 'completion failed')
    const line = JSON.parse(lines[0])
    expect(line.err.response).toEqual({ status: 502, self: '[Circular]' })
    expect(line.err.empty).toBeNull()
    expect(line.err.stack).toBe('12345')
  })

  it("keeps every aggregate member's message, not the first member's stack", () => {
    const { log, lines } = capture()
    const err = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:5432'),
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      ],
      'connect failed'
    )
    log.error({ err }, 'database unreachable')
    expect(lines[0]).toContain('127.0.0.1:5432')
  })
})

describe('createLogger', () => {
  it('should create a logger with expected methods', () => {
    const log = createLogger({ name: 'test-app', level: 'silent' })
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.debug).toBe('function')
    expect(typeof log.child).toBe('function')
  })

  it('should use the provided level', () => {
    const log = createLogger({ name: 'test', level: 'warn' })
    expect(log.level).toBe('warn')
  })

  it('should default to info level when no level or env provided', () => {
    const original = process.env.LOG_LEVEL
    delete process.env.LOG_LEVEL
    try {
      const log = createLogger({ name: 'test' })
      expect(log.level).toBe('info')
    } finally {
      if (original) process.env.LOG_LEVEL = original
    }
  })

  it('should use LOG_LEVEL env when no level option provided', () => {
    const original = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'debug'
    try {
      const log = createLogger({ name: 'test' })
      expect(log.level).toBe('debug')
    } finally {
      if (original) {
        process.env.LOG_LEVEL = original
      } else {
        delete process.env.LOG_LEVEL
      }
    }
  })

  it('should prefer explicit level over LOG_LEVEL env', () => {
    const original = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'debug'
    try {
      const log = createLogger({ name: 'test', level: 'error' })
      expect(log.level).toBe('error')
    } finally {
      if (original) {
        process.env.LOG_LEVEL = original
      } else {
        delete process.env.LOG_LEVEL
      }
    }
  })

  it('should support silent level for test suppression', () => {
    const log = createLogger({ name: 'test', level: 'silent' })
    expect(log.level).toBe('silent')
    // Should not throw when logging at silent level
    log.info('this should be silenced')
    log.error('this too')
  })

  it('should support child loggers', () => {
    const parent = createLogger({ name: 'parent', level: 'silent' })
    const child = parent.child({ requestId: 'req-123' })
    expect(child).toBeDefined()
    expect(typeof child.info).toBe('function')
    // Should not throw
    child.info({ extra: 'data' }, 'child message')
  })
})
