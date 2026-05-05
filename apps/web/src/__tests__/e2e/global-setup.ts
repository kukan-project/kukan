/**
 * Playwright E2E global setup.
 * Ensures the .auth directory exists for storageState files.
 */

import { mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default async function globalSetup() {
  mkdirSync(resolve(__dirname, '../.auth'), { recursive: true })
}
