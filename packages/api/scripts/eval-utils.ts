/** Shared helpers for the golden-set eval harnesses (eval-search / eval-suggest). */

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
