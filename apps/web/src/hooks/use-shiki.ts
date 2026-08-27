import { useEffect, useState } from 'react'
import type { HighlighterCore } from 'shiki/core'

export type HighlightLang = 'bash' | 'javascript' | 'sql'

const LIGHT_THEME = 'github-light-default'
const DARK_THEME = 'github-dark-default'

let highlighterPromise: Promise<HighlighterCore> | null = null

/**
 * Singleton fine-grained shiki bundle: three grammars, two themes, and the
 * lightweight JS regex engine — everything loads lazily on first use so none
 * of it reaches the initial page bundle.
 */
function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      bash,
      javascript,
      sql,
      light,
      dark,
    ] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/themes/github-light-default.mjs'),
      import('shiki/themes/github-dark-default.mjs'),
    ])
    return createHighlighterCore({
      langs: [bash.default, javascript.default, sql.default],
      themes: [light.default, dark.default],
      engine: createJavaScriptRegexEngine(),
    })
  })().catch((err) => {
    // Allow retry on a later mount if a lazy chunk fails to load (network hiccup)
    highlighterPromise = null
    throw err
  })
  return highlighterPromise
}

/**
 * Code to shiki HTML (a `pre.shiki` block). Styling hooks live in globals.css.
 * `focusable: false` drops shiki's default `tabindex="0"` — required for
 * aria-hidden mirrors, which must never receive keyboard focus.
 */
export function highlight(
  h: HighlighterCore,
  code: string,
  lang: HighlightLang,
  opts?: { focusable?: boolean }
): string {
  return h.codeToHtml(code, {
    lang,
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    tabindex: opts?.focusable === false ? false : '0',
  })
}

/** The shared highlighter once loaded; null until then (render plain as fallback). */
export function useHighlighter(): HighlighterCore | null {
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null)

  useEffect(() => {
    let active = true
    loadHighlighter().then(
      (h) => {
        if (active) setHighlighter(h)
      },
      // Plain rendering stays on failure; the next mount retries the load.
      () => {}
    )
    return () => {
      active = false
    }
  }, [])

  return highlighter
}
