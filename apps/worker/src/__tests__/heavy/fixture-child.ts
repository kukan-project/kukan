// A heavy process whose work a test chooses: answering, failing, crashing, or
// never finishing
import { becomeExpendable, serve } from '@kukan/api/services/child/serve'

type Request = { kind: 'pid' } | { kind: 'fail' } | { kind: 'crash' } | { kind: 'hang' }

becomeExpendable()

serve<Request>(async (request) => {
  switch (request.kind) {
    case 'pid':
      return { ok: true, result: process.pid }
    case 'fail':
      return { ok: false, message: 'refused' }
    case 'crash':
      return process.exit(3)
    case 'hang':
      return new Promise<never>(() => {})
  }
})
