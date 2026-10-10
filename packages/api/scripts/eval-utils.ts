/** Shared helpers for the golden-set eval harnesses (eval-search / eval-passages / eval-suggest). */

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

/** Right-aligned percentage; null → placeholder (unmeasured metric). */
export function pct(value: number | null): string {
  return value === null ? '  — ' : (value * 100).toFixed(0).padStart(3) + '%'
}

/** First 200 chars of a response body, for warn/error detail. */
export function responseDetail(res: Response): Promise<string> {
  return res
    .text()
    .then((t) => t.slice(0, 200))
    .catch(() => '')
}

/**
 * GET `url` as JSON, retrying once on a 5xx — a transient dev-server/backend
 * blip should not abort a whole run. Throws with the response's detail otherwise.
 */
export async function getJson<T>(url: string, label = url): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok) return (await res.json()) as T
    const detail = await responseDetail(res)
    if (res.status >= 500 && attempt === 0) {
      console.warn(`  retrying ${label} after ${res.status}: ${detail}`)
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    throw new Error(`${label} failed (${res.status}): ${detail}`)
  }
}
