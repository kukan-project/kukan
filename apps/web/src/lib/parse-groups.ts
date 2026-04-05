export function parseGroups(groups?: string): { name: string; title: string }[] {
  if (!groups) return []
  return groups
    .split(',')
    .filter(Boolean)
    .map((g) => {
      const [name, ...rest] = g.split(':')
      return { name, title: rest.join(':') || name }
    })
}
