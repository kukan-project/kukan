/**
 * Read-only SQL guard for server-side resource queries (ADR-032 Part B).
 *
 * This is ONE layer of defense. The real guarantee is the DuckDB sandbox lockdown
 * (`enable_external_access=false` + `lock_configuration=true` on a throwaway in-memory
 * instance, see duckdb-sandbox.ts). The guard rejects the obvious cases early with a
 * clear message, but it is a lexer approximation, not DuckDB's parser: the sandbox
 * also has DuckDB itself count the statements and type the one it runs.
 */

import { ValidationError } from '@kukan/shared'

export const SINGLE_STATEMENT_MESSAGE = 'Only a single SQL statement is allowed'
export const READ_ONLY_MESSAGE = 'Only read-only SELECT or WITH queries are allowed'

// Character classes of DuckDB's (PostgreSQL-derived) scanner. `$` continues an
// identifier, so `a$$` is a name, not the start of a dollar-quoted string.
const IDENT_START = /[A-Za-z_\u0080-\uffff]/
const IDENT_CONT = /[A-Za-z0-9_$\u0080-\uffff]/
// `$$` or `$tag$`; a tag cannot start with a digit (`$1` is a parameter).
const DOLLAR_DELIM_RE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y
// Whitespace with a newline (`--` comments count, block comments do not) joins two
// string literals, and an `E` string stays one across it. A comment must end in its
// newline, which keeps the match linear on a run of dashes.
const STRING_CONTINUATION_RE =
  /[ \t\f]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f]|--[^\n\r]*[\n\r])*(?=')/y

/** Index just past the quoted run opened at `i`, honoring `''` and optionally `\x`. */
function skipQuoted(sql: string, i: number, quote: string, backslash: boolean): number {
  const n = sql.length
  i++
  while (i < n) {
    if (backslash && sql[i] === '\\') {
      i += 2
      continue
    }
    if (sql[i] === quote && sql[i + 1] === quote) {
      i += 2 // escaped quote
      continue
    }
    if (sql[i] === quote) return i + 1
    i++
  }
  return n
}

/** Index just past the `E'…'` string whose quote is at `i`, continuations included. */
function skipEscapeString(sql: string, i: number): number {
  for (;;) {
    i = skipQuoted(sql, i, "'", true)
    STRING_CONTINUATION_RE.lastIndex = i
    if (!STRING_CONTINUATION_RE.test(sql)) return i
    i = STRING_CONTINUATION_RE.lastIndex
  }
}

/** Index just past a dollar-quoted string opened at `i`, or undefined if none opens there. */
function skipDollarQuoted(sql: string, i: number): number | undefined {
  DOLLAR_DELIM_RE.lastIndex = i
  const delim = DOLLAR_DELIM_RE.exec(sql)?.[0]
  if (delim === undefined) return undefined
  const close = sql.indexOf(delim, i + delim.length)
  return close === -1 ? sql.length : close + delim.length
}

/**
 * Blank out comments and quoted strings/identifiers so statement boundaries and the
 * leading keyword can be examined without false matches from `;` or keywords that
 * appear inside literals (e.g. `SELECT ';drop'`). Besides `'…'`, this reads `E'…'`
 * with backslash escapes, `$$…$$` / `$tag$…$tag$`, and nested block comments.
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
      let depth = 1
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      out += ' '
    } else if ((c === 'e' || c === 'E') && next === "'") {
      i = skipEscapeString(sql, i + 1)
      out += "''"
    } else if (IDENT_START.test(c)) {
      // Consumed whole so a `$` or `e'` inside a name is not read as a quote opener.
      const from = i
      while (i < n && IDENT_CONT.test(sql[i])) i++
      out += sql.slice(from, i)
    } else if (c === "'" || c === '"') {
      i = skipQuoted(sql, i, c, false)
      out += c + c // collapse to an empty literal/identifier
    } else if (c === '$') {
      const end = skipDollarQuoted(sql, i)
      out += end === undefined ? c : "''"
      i = end ?? i + 1
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
    throw new ValidationError(SINGLE_STATEMENT_MESSAGE)
  }

  if (!/^(select|with)\b/i.test(withoutTrailing)) {
    throw new ValidationError(READ_ONLY_MESSAGE)
  }

  // A SELECT/WITH lead is not enough: a CTE can wrap a writing statement
  // (`WITH x AS (...) DELETE FROM data`). Reject statement-level write/DDL keywords.
  // The scrubbed text has string/identifier contents blanked, so this won't false-match
  // a column or string value.
  if (WRITE_KEYWORD_RE.test(withoutTrailing)) {
    throw new ValidationError(READ_ONLY_MESSAGE)
  }
}
