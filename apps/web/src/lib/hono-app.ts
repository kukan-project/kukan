import type { createApp } from '@kukan/api'

type App = Awaited<ReturnType<typeof createApp>>

const globalForApp = globalThis as unknown as { __kukanApp?: Promise<App> }

export function getApp(): Promise<App> {
  if (!globalForApp.__kukanApp) {
    globalForApp.__kukanApp = import('@kukan/api')
      .then((m) => m.createApp())
      .catch((err) => {
        globalForApp.__kukanApp = undefined
        throw err
      })
  }
  return globalForApp.__kukanApp
}
