/**
 * Read-only SQL guard for server-side resource queries (ADR-032 Part B).
 *
 * This is ONE layer of defense. The real guarantee is the DuckDB sandbox lockdown
 * (`enable_external_access=false` + `lock_configuration=true` on a throwaway in-memory
 * instance, see duckdb-sandbox.ts). The guard rejects the obvious cases early so a
 * blocked query never reaches the engine, but it is not the only barrier.
 */

import { ValidationError } from '@kukan/shared'

/**
 * Blank out comments and quoted strings/identifiers so statement boundaries and the
 * leading keyword can be examined without false matches from `;` or keywords that
 * appear inside literals (e.g. `SELECT ';drop'`).
 */
function scrub(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      out += ' '
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
    } else if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2 // escaped quote
          continue
        }
        if (sql[i] === quote) {
          i++
          break
        }
        i++
      }
      out += quote + quote // collapse to an empty literal/identifier
    } else {
      out += c
      i++
    }
  }
  return out
}

// Statement-level write/DDL keywords. `replace` is intentionally excluded — it is a
// SELECT string function and the `SELECT * REPLACE (...)` star modifier.
const WRITE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'create',
  'alter',
  'truncate',
  'merge',
  'attach',
  'detach',
  'copy',
  'export',
  'import',
  'install',
  'load',
  'pragma',
  'call',
  'vacuum',
  'checkpoint',
  'begin',
  'commit',
  'rollback',
]
const WRITE_KEYWORD_RE = new RegExp(`\\b(${WRITE_KEYWORDS.join('|')})\\b`, 'i')

/**
 * Assert that `sql` is a single read-only statement. Throws ValidationError (400)
 * otherwise. Allows exactly one statement beginning with SELECT or WITH; anything
 * else (DDL/DML, PRAGMA, ATTACH, COPY, multiple statements, …) is rejected.
 */
export function assertReadOnlySql(sql: string): void {
  const scrubbed = scrub(sql).trim()
  if (!scrubbed) {
    throw new ValidationError('SQL query must not be empty')
  }

  // Single statement only: no ';' except an optional trailing one.
  const withoutTrailing = scrubbed.replace(/;\s*$/, '')
  if (withoutTrailing.includes(';')) {
    throw new ValidationError('Only a single SQL statement is allowed')
  }

  if (!/^(select|with)\b/i.test(withoutTrailing)) {
    throw new ValidationError('Only read-only SELECT or WITH queries are allowed')
  }

  // A SELECT/WITH lead is not enough: a CTE can wrap a writing statement
  // (`WITH x AS (...) DELETE FROM data`). Reject statement-level write/DDL keywords.
  // The scrubbed text has string/identifier contents blanked, so this won't false-match
  // a column or string value.
  if (WRITE_KEYWORD_RE.test(withoutTrailing)) {
    throw new ValidationError('Only read-only SELECT or WITH queries are allowed')
  }
}
