import { getApp } from '@/lib/hono-app'

async function handler(req: Request) {
  const app = await getApp()
  return app.fetch(req)
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
