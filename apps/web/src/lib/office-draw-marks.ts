/**
 * A mark in this browser that a document is open in ibisOffice (ADR-065 decision
 * 3). What takes a tab down leaves nothing but this behind: the mark outlives
 * the tab, stops being renewed, and tells the next visit to open on the extracted
 * text. It stays in the visitor's browser, and where storage is unavailable none
 * of this happens.
 */

const PREFIX = 'kukan:ibis-office-draw:'
const TAB_KEY = 'kukan:ibis-office-tab'
/** How often a tab with a document open renews its mark */
const RENEW_MS = 3_000
/** Older than this, no tab is renewing it: a tab that hides removes its own */
const STALE_MS = 10_000
/** Older than this, the document is tried again: ibisOffice may have improved */
const EXPIRES_MS = 24 * 60 * 60 * 1000

/** The documents this page has open, whose marks here say nothing of a crash */
const openHere = new Set<string>()

function attempt(write: () => void): void {
  try {
    write()
  } catch {
    // Storage unavailable or full: no mark
  }
}

/** Kept across a reload, as of the tab that crashed: Chrome's Reload button is right there. */
function thisTab(): string {
  let tab = sessionStorage.getItem(TAB_KEY)
  if (!tab) {
    tab = Math.random().toString(36).slice(2)
    sessionStorage.setItem(TAB_KEY, tab)
  }
  return tab
}

function markKey(doc: string): string {
  return `${PREFIX}${doc}:${thisTab()}`
}

function marks(prefix = PREFIX): { key: string; age: number }[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter((key): key is string => !!key?.startsWith(prefix))
    .map((key) => ({ key, age: Date.now() - Number(localStorage.getItem(key)) }))
}

const marksOf = (doc: string) => marks(`${PREFIX}${doc}:`)

/** Whether a tab with this document open last went down with it. */
export function crashedBefore(doc: string): boolean {
  try {
    // Any document's, or those of a version no one opens again would stay
    for (const { key, age } of marks()) {
      if (age >= EXPIRES_MS) localStorage.removeItem(key)
    }
    const own = markKey(doc)
    return marksOf(doc).some(
      ({ key, age }) => age >= STALE_MS || (key === own && !openHere.has(doc))
    )
  } catch {
    return false
  }
}

/**
 * Marks the document as open, replacing what an earlier crash left, and gives
 * back what to call on closing it. Only while the tab is seen: a hidden one's
 * timers slow to where other tabs would take it for gone.
 */
export function openDocument(doc: string): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const renew = () => attempt(() => localStorage.setItem(markKey(doc), String(Date.now())))
  const unmark = () => {
    clearInterval(timer)
    attempt(() => localStorage.removeItem(markKey(doc)))
  }
  const onVisibility = () => {
    unmark()
    if (document.hidden) return
    renew()
    timer = setInterval(renew, RENEW_MS)
  }
  const close = () => {
    document.removeEventListener('visibilitychange', onVisibility)
    removeEventListener('pagehide', unmark)
    removeEventListener('pageshow', onVisibility)
    openHere.delete(doc)
    unmark()
  }

  attempt(() => {
    for (const { key, age } of marksOf(doc)) {
      if (age >= STALE_MS) localStorage.removeItem(key)
    }
  })
  openHere.add(doc)
  document.addEventListener('visibilitychange', onVisibility)
  addEventListener('pagehide', unmark)
  // Back from the back/forward cache, the frame is too, and no effect runs again
  addEventListener('pageshow', onVisibility)
  onVisibility()
  return close
}
