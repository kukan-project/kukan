/**
 * Run `fn` over `items` with at most `limit` in flight (order preserved).
 *
 * A failure stops new items from starting, and is thrown only once those in
 * flight have ended: a caller that holds a slot around this — a semaphore over
 * memory — must not give it back while work it bounds is still running.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failure: { error: unknown } | null = null
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failure) {
        const index = next++
        if (index >= items.length) return
        try {
          results[index] = await fn(items[index]!)
        } catch (error) {
          failure ??= { error }
        }
      }
    })
  )
  if (failure) throw (failure as { error: unknown }).error
  return results
}
