/** The last caller in line for each key in this process. */
const turns = new Map<string, Promise<void>>()

/**
 * Run `fn` once every earlier caller for `key` in this process has finished,
 * whether it returned or threw. One at a time per key, in the order they asked.
 */
export async function inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = turns.get(key) ?? Promise.resolve()
  let done!: () => void
  const finished = new Promise<void>((resolve) => (done = resolve))
  const mine = before.then(() => finished)
  turns.set(key, mine)
  await before
  try {
    return await fn()
  } finally {
    done()
    if (turns.get(key) === mine) turns.delete(key)
  }
}
