/**
 * KUKAN Logger Factory
 * Shared pino logger configuration (ADR-019).
 * NOT a logging adapter — just a config factory (ADR-005).
 */

import pino from 'pino'
import type { Logger, LevelWithSilent } from 'pino'
import { clipText } from './utils'

export type { Logger }

export interface CreateLoggerOptions {
  /** Logger name — typically 'api' or 'worker' */
  name: string
  /** Log level override (default: LOG_LEVEL env or 'info') */
  level?: LevelWithSilent
}

const PRETTY_OPTS = {
  colorize: true,
  translateTime: 'SYS:HH:MM:ss.l',
  ignore: 'pid,hostname',
}

/**
 * Fields no log line should carry in clear, wherever a caller passes them.
 * Nothing logs these today; this is the net for the day something does.
 * A `*` stands for exactly one level, so the top-level names are listed too.
 * Paths are case-sensitive; header names are lower case as Node and the
 * Fetch API's Headers hand them out. The two API token headers are the ones
 * the auth middleware reads besides `authorization`.
 */
export const LOG_REDACT_PATHS = [
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  '["x-kukan-api-key"]',
  '*["x-kukan-api-key"]',
  '["x-ckan-api-key"]',
  '*["x-ckan-api-key"]',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-kukan-api-key"]',
  'req.headers["x-ckan-api-key"]',
  // An SDK's error carries the response's headers — an AI provider's org and
  // project ids among them — and an error is logged whole as `err`
  'err.headers',
]

/** An error's message as logged, at most — the same bound the worker's step records keep. */
const LOG_ERROR_MESSAGE_MAX_CHARS = 1_000
/** Its stack: the message's share is clipped above, so this is frames and causes. */
const LOG_ERROR_STACK_MAX_CHARS = 4_000

/** The AWS SDK's raw response, which holds the body, wherever it sits in an error. */
const DROPPED_ERROR_KEYS = new Set(['$response', '$responseBodyText'])

/**
 * A field as compact JSON: the raw response dropped, a nested error's stack too
 * (an aggregate's first member would fill the bound and hide the rest), a cycle
 * marked rather than failing the whole field.
 */
function fieldJson(value: object): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (key, v: unknown) => {
        if (DROPPED_ERROR_KEYS.has(key) || key === 'stack') return undefined
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      }) ?? 'null'
    )
  } catch {
    return '"[Unserializable]"'
  }
}
/** pino's own fields, bounded on their own terms below */
const ERROR_OWN_KEYS = new Set(['type', 'message', 'stack'])

/**
 * pino's error serializer, with every field bounded and the AWS SDK's raw
 * response left out.
 *
 * A provider's error message can be its whole response body — 4,000
 * characters seen from one — and a body can echo what was sent. The message
 * is repeated at the head of the stack, so it is clipped there too. The other
 * fields are where SDKs keep the rest of the response (the OpenAI SDK's
 * `error`, a wrapped error, an aggregate's members), and pino serializes the
 * errors among them itself, past this function — so each is written as
 * compact JSON and clipped, shape kept only when it is short.
 */
export function serializeLogError(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error)
  // Not error-like: pino hands it back untouched
  if (out === err) return out
  // pino has read it as a string; `out.message` also carries the causes'
  const { message } = err as Error
  out.message = clipText(out.message, LOG_ERROR_MESSAGE_MAX_CHARS)
  let stack = String(out.stack)
  if (typeof message === 'string' && message.length > LOG_ERROR_MESSAGE_MAX_CHARS) {
    stack = stack.replace(message, () => clipText(message, LOG_ERROR_MESSAGE_MAX_CHARS))
  }
  out.stack = clipText(stack, LOG_ERROR_STACK_MAX_CHARS)
  const fields = out as unknown as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (ERROR_OWN_KEYS.has(key)) continue
    if (DROPPED_ERROR_KEYS.has(key)) {
      delete fields[key]
      continue
    }
    const value = fields[key]
    if (typeof value === 'string') {
      fields[key] = clipText(value, LOG_ERROR_MESSAGE_MAX_CHARS)
    } else if (typeof value === 'object' && value !== null) {
      const json = fieldJson(value)
      fields[key] =
        json.length <= LOG_ERROR_MESSAGE_MAX_CHARS
          ? (JSON.parse(json) as unknown)
          : clipText(json, LOG_ERROR_MESSAGE_MAX_CHARS)
    }
  }
  return out
}

/** One pino-pretty worker thread, shared by every logger in the process. */
let prettyTransport: pino.DestinationStream | null | undefined
function sharedPrettyTransport(): pino.DestinationStream | null {
  if (prettyTransport === undefined) {
    try {
      prettyTransport = pino.transport({ target: 'pino-pretty', options: PRETTY_OPTS })
    } catch {
      // pino-pretty not available — fall back to JSON
      prettyTransport = null
    }
  }
  return prettyTransport
}

/**
 * Create a pino logger instance.
 *
 * - Production / tests / piped output: JSON to stdout (CloudWatch Logs compatible)
 * - Development: pino-pretty in a worker thread
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info'
  const baseOpts: pino.LoggerOptions = {
    name: options.name,
    level,
    redact: LOG_REDACT_PATHS,
    serializers: { err: serializeLogError },
  }

  // `next dev` hands its server's output to the parent over a socket, not a TTY
  const pretty = process.stdout?.isTTY || process.env.NODE_ENV === 'development'
  // pino's browser and Edge builds have no transport
  const stream = pretty && typeof pino.transport === 'function' ? sharedPrettyTransport() : null
  return stream ? pino(baseOpts, stream) : pino(baseOpts)
}
