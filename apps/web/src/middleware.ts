import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const secret = process.env.ORIGIN_VERIFY_SECRET
  if (secret && request.headers.get('x-origin-verify') !== secret) {
    return new NextResponse('Forbidden', { status: 403 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api/health).*)'],
}
