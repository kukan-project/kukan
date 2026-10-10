import { useVisibleInterval } from './use-visible-interval'

/**
 * How often a status is read again once work is queued. Slower than a page's
 * own refresh: behind each read are counts over the whole catalogue, and the
 * work they follow takes minutes at the least.
 */
const QUEUED_WORK_POLL_MS = 15_000

/**
 * Follow work a button queued: `reload` every so often while `queued`, and only
 * then — nothing is read before the press. `reload` should settle when its
 * answer has landed, so a slow one is not overlapped by the next.
 */
export function useQueuedWorkPoll(reload: () => unknown, queued: boolean) {
  useVisibleInterval(reload, QUEUED_WORK_POLL_MS, queued)
}
