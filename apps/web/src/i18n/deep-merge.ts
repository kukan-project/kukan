export type Messages = Record<string, unknown>

export function deepMerge(base: Messages, override: Messages): Messages {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    if (
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(result[key] as Messages, override[key] as Messages)
    } else {
      result[key] = override[key]
    }
  }
  return result
}
