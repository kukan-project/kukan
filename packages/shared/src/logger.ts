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
 * Try to create an in-process pino-pretty stream via native require.
 * Uses __non_webpack_require__ in webpack to bypass static analysis,
 * avoiding both bundling errors and worker-thread instability.
 * Memoized: a single stream is shared across all logger instances.
 */
let _prettyStream: pino.DestinationStream | null | undefined
function createPrettyStream(): pino.DestinationStream | null {
  if (_prettyStream !== undefined) return _prettyStream
  try {
    // @ts-expect-error -- __non_webpack_require__ is webpack's native require escape hatch
    if (typeof __non_webpack_require__ === 'function') {
      // @ts-expect-error -- __non_webpack_require__ bypasses webpack static analysis
      const mod = __non_webpack_require__('pino-pretty')
      _prettyStream = (mod.default ?? mod)(PRETTY_OPTS) as pino.DestinationStream
      return _prettyStream
    }
  } catch {
    // pino-pretty not available — fall through
  }
  _prettyStream = null
  return null
}

/**
 * Create a pino logger instance.
 *
 * - Production / non-TTY: JSON to stdout (CloudWatch Logs compatible)
 * - Development (native Node.js): pino-pretty via worker-thread transport
 * - Development (Next.js webpack): pino-pretty in-process via native require
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info'
  const baseOpts: pino.LoggerOptions = { name: options.name, level }

  if (!process.stdout?.isTTY) {
    return pino(baseOpts)
  }

  // Webpack (Next.js): in-process pino-pretty stream (no worker threads)
  const stream = createPrettyStream()
  if (stream) return pino(baseOpts, stream)

  // Native Node.js (API standalone / Worker): worker-thread transport
  if (typeof pino.transport === 'function') {
    try {
      return pino({
        ...baseOpts,
        transport: { target: 'pino-pretty', options: PRETTY_OPTS },
      })
    } catch {
      // fall through to JSON
    }
  }

  return pino(baseOpts)
}
