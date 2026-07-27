/** SQL literal/identifier helpers for the server-composed DuckLake statements. */

/** Escape a value for a single-quoted SQL literal. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Quote an identifier we did not generate — column names come from CSV headers,
 * so they are arbitrary text and cannot be validated, only escaped.
 */
export function sqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Assert an identifier we generated ourselves (table names derived from UUIDs).
 * Table names never come from user input, so this is a guard against
 * programming errors rather than untrusted input.
 */
export function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`)
  }
  return name
}
