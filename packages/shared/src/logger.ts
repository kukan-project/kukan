/**
 * KUKAN Logger Factory
 * Shared pino logger configuration (ADR-019).
 * NOT a logging adapter — just a config factory (ADR-005).
 */

import pino from 'pino'
import type { Logger, LevelWithSilent } from 'pino'

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
 */
export const LOG_REDACT_PATHS = [
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.cookie',
  'req.headers.authorization',
]

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
  const baseOpts: pino.LoggerOptions = { name: options.name, level, redact: LOG_REDACT_PATHS }

  // `next dev` hands its server's output to the parent over a socket, not a TTY
  const pretty = process.stdout?.isTTY || process.env.NODE_ENV === 'development'
  // pino's browser and Edge builds have no transport
  const stream = pretty && typeof pino.transport === 'function' ? sharedPrettyTransport() : null
  return stream ? pino(baseOpts, stream) : pino(baseOpts)
}
