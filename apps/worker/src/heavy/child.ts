/**
 * The worker's heavy process (ADR-059): interprets CSVs and extracts the text
 * of documents, one request at a time, for as long as the worker keeps it.
 */

import { becomeExpendable, serve } from '@kukan/api/services/child/serve'
import { answer } from './answer'
import type { HeavyReply, HeavyRequest } from './protocol'

// At the worker's own priority, unlike the web's queries: its requests run one
// at a time, so a request slowed is every job behind it slowed
becomeExpendable()

serve<HeavyRequest>((request) =>
  answer(request).then(
    (result): HeavyReply => ({ ok: true, result }),
    (err: unknown): HeavyReply => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    })
  )
)
