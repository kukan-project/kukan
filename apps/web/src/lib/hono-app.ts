import type { createApp } from '@kukan/api'

type AppResult = Awaited<ReturnType<typeof createApp>>
type App = AppResult['app']

const globalForApp = globalThis as unknown as { __kukanApp?: Promise<App> }

export function getApp(): Promise<App> {
  // In development, recreate the app to pick up code changes (HMR-safe).
  // The DB pool is cached in globalThis by createDb(), so no connection leak.
  if (process.env.NODE_ENV !== 'production') {
    return import('@kukan/api').then((m) => m.createApp().then((r) => r.app))
  }
  if (!globalForApp.__kukanApp) {
    globalForApp.__kukanApp = import('@kukan/api')
      .then((m) => m.createApp().then((r) => r.app))
      .catch((err) => {
        globalForApp.__kukanApp = undefined
        throw err
      })
  }
  return globalForApp.__kukanApp
}

// Graceful shutdown — close the DB pool when the process exits
// Guard with globalThis to prevent duplicate listeners during HMR reloads
const globalForShutdown = globalThis as unknown as { __kukanShutdownRegistered?: boolean }
if (!globalForShutdown.__kukanShutdownRegistered) {
  const shutdown = async () => {
    const { closePool } = await import('@kukan/api')
    await closePool()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  globalForShutdown.__kukanShutdownRegistered = true
}
