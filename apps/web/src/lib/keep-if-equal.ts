/**
 * For a state setter: the previous value when the next one holds the same
 * data, so a poll that finds nothing new re-renders nothing. For plain JSON
 * from the API, where the server writes keys in one order.
 */
export function keepIfEqual<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}
