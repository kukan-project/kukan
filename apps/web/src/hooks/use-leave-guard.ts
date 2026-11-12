'use client'

import { useEffect } from 'react'

/** Marks the history entry the guard adds over the page's own */
const GUARD_ENTRY = '__kukanLeaveGuard'

function holdsGuardEntry(state: unknown): boolean {
  return !!state && typeof state === 'object' && GUARD_ENTRY in state
}

function pushGuardEntry() {
  window.history.pushState({ ...window.history.state, [GUARD_ENTRY]: true }, '')
}

/**
 * While `active`, leaving the page asks first: a reload or closing the tab
 * through the browser's own prompt, a click on a link to another page and the
 * browser's Back through `message`. A link to a page under `within` goes
 * unasked: what is unsaved stays on the screen across it.
 *
 * Links are caught on the document in the capture phase, before Next's `Link`
 * sees the click: the App Router has no event for a navigation about to happen,
 * so stopping one is only possible before it starts.
 *
 * Back is caught with an entry of the page's own address pushed over it: Back
 * then lands on the page itself, and the guard asks there — staying pushes the
 * entry again, leaving takes the one further step back. When the guard stands
 * down on the page (the edits were saved), it takes its entry away again.
 * Pushing the entry drops the Forward history, as any `pushState` does: a page
 * reached by Back and then edited loses the pages ahead of it. Kept anyway —
 * edits lost to Back cannot be had again, a page ahead can be reached by its link.
 */
export function useLeaveGuard(active: boolean, message: string, within?: string | null) {
  useEffect(() => {
    if (!active) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    let leaving = false
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return
      // A new tab or window leaves this page where it is
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const anchor = (e.target as Element | null)?.closest?.('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return
      const to = new URL(anchor.href, window.location.href)
      if (to.origin === window.location.origin) {
        // The same page, only a fragment apart
        if (to.pathname === window.location.pathname && to.search === window.location.search) return
        // Still inside what holds the unsaved edits
        if (within && (to.pathname === within || to.pathname.startsWith(`${within}/`))) return
      }
      if (window.confirm(message)) {
        // Off the guard's entry first, then on: followed from on top of it,
        // the entry stays behind the new page, and Back from there lands on
        // this page twice. Stepping back is asynchronous, so the link is
        // followed again once it has landed, with the guard out of its way.
        if (!holdsGuardEntry(window.history.state)) return
        e.preventDefault()
        e.stopPropagation()
        leaving = true
        window.removeEventListener('beforeunload', warn)
        document.removeEventListener('click', onClick, true)
        const follow = () => {
          window.removeEventListener('popstate', follow)
          anchor.click()
        }
        window.addEventListener('popstate', follow)
        window.history.back()
        return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    const onPopState = (e: PopStateEvent) => {
      // Forward onto the guard's own entry: still on the page
      if (leaving || holdsGuardEntry(e.state)) return
      if (window.confirm(message)) {
        leaving = true
        // Asked once already: a step back out of the document must not ask again
        window.removeEventListener('beforeunload', warn)
        window.history.back()
      } else {
        pushGuardEntry()
      }
    }
    pushGuardEntry()
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPopState)
      // Still on the guard's entry: the page stays and only the guard goes.
      // After a link, the address has already moved on and the entry is left.
      if (!leaving && holdsGuardEntry(window.history.state)) window.history.back()
    }
  }, [active, message, within])
}
