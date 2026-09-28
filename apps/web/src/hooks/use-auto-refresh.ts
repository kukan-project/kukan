'use client'

import { useCallback, useState } from 'react'
import { useVisibleInterval } from './use-visible-interval'

/** How often a page looks again while it is on screen */
const POLL_INTERVAL_MS = 5_000
/** A poll spins the refresh icon at least one turn, so a fast one is still seen */
const POLL_SPIN_MS = 1_000

/**
 * A page's refresh button, and a page that keeps itself fresh: `reload` from
 * the button, and `poll`, when given, every few seconds while the tab is
 * visible (quietly — it should keep what is shown when nothing changed).
 * `spinning` is for the button's icon, turning for either; only a press
 * disables the button.
 */
export function useAutoRefresh({
  poll,
  reload,
  enabled = true,
}: {
  poll?: () => Promise<unknown>
  reload: () => Promise<unknown>
  /** false pauses the polls (a dialog open, say) */
  enabled?: boolean
}) {
  const [polling, setPolling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useVisibleInterval(
    async () => {
      setPolling(true)
      await Promise.all([
        // A failed poll keeps what is shown; the next one tries again
        poll?.().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, POLL_SPIN_MS)),
      ])
      setPolling(false)
    },
    POLL_INTERVAL_MS,
    enabled && poll !== undefined
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    // As a poll: a failed reload keeps what is shown, and frees the button
    await reload().catch(() => {})
    setRefreshing(false)
  }, [reload])

  return { spinning: polling || refreshing, refreshing, refresh }
}
