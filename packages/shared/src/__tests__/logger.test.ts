import { Writable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { createLogger, LOG_REDACT_PATHS } from '../logger'

describe('LOG_REDACT_PATHS', () => {
  it('censors credentials at the top level, one level down and in request headers', () => {
    const lines: string[] = []
    const log = pino(
      { redact: LOG_REDACT_PATHS },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(String(chunk))
          callback()
        },
      })
    )
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
