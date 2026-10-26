import 'server-only'
import { version } from '../../../../package.json'

/**
 * What this deployment is running.
 *
 * The release is the repository's `package.json` version — the one place a
 * release is recorded (ADR-035). Imported rather than read at runtime, so
 * `next build` embeds the value and the image needs no copy of the file.
 *
 * `server-only` keeps this out of the client bundle: importing `package.json`
 * from a client component would put the whole file in a chunk anyone can
 * fetch, and `process.version` is not there to read at all.
 */
export interface BuildInfo {
  /** The release, e.g. `0.35.1` */
  version: string
  /** The Node runtime the process is on, e.g. `v24.21.0` */
  node: string
}

export function buildInfo(): BuildInfo {
  return { version, node: process.version }
}
