import { describe, it, expect } from 'vitest'
import {
  escapeSQL,
  escapeLike,
  quoteColumn,
  parquetFileName,
  buildWhereClause,
  buildQuery,
} from '../duckdb-sql'

describe('escapeSQL', () => {
  it('escapes single quotes', () => {
    expect(escapeSQL("it's")).toBe("it''s")
  })

  it('does not escape backslashes (not special in DuckDB standard strings)', () => {
    expect(escapeSQL('a\\b')).toBe('a\\b')
  })

  it('escapes only quotes when both present', () => {
    expect(escapeSQL("C:\\it's")).toBe("C:\\it''s")
  })

  it('returns unchanged for safe strings', () => {
    expect(escapeSQL('hello')).toBe('hello')
  })
})

describe('escapeLike', () => {
  it('escapes % wildcard with $ prefix', () => {
    expect(escapeLike('100%')).toBe('100$%')
  })

  it('escapes _ wildcard with $ prefix', () => {
    expect(escapeLike('foo_bar')).toBe('foo$_bar')
  })

  it('escapes $ (the escape char itself)', () => {
    expect(escapeLike('$10')).toBe('$$10')
  })

  it('does not escape backslash (not special in ESCAPE $ mode)', () => {
    expect(escapeLike('C:\\tmp')).toBe('C:\\tmp')
  })

  it('escapes all special characters together', () => {
    expect(escapeLike("50%_$it's")).toBe("50$%$_$$it''s")
  })
})

describe('quoteColumn', () => {
  it('wraps in double quotes', () => {
    expect(quoteColumn('name')).toBe('"name"')
  })

  it('escapes double quotes in column name', () => {
    expect(quoteColumn('col"name')).toBe('"col""name"')
  })
})

describe('parquetFileName', () => {
  it('generates filename from resourceId', () => {
    expect(parquetFileName('abc-123')).toBe('preview_abc-123.parquet')
  })
})

describe('buildWhereClause', () => {
  const columns = ['name', 'city', 'age']

  it('returns empty string with no filters or search', () => {
    expect(buildWhereClause(columns)).toBe('')
  })

  it('builds eq filter', () => {
    const result = buildWhereClause(columns, [{ column: 'name', operator: 'eq', value: 'Alice' }])
    expect(result).toBe(`WHERE CAST("name" AS VARCHAR) = 'Alice'`)
  })

  it('builds neq filter', () => {
    const result = buildWhereClause(columns, [{ column: 'name', operator: 'neq', value: 'Bob' }])
    expect(result).toBe(`WHERE CAST("name" AS VARCHAR) != 'Bob'`)
  })

  it('builds contains filter with ESCAPE clause', () => {
    const result = buildWhereClause(columns, [
      { column: 'city', operator: 'contains', value: 'York' },
    ])
    expect(result).toBe(`WHERE CAST("city" AS VARCHAR) ILIKE '%York%' ESCAPE '$'`)
  })

  it('builds starts_with filter with ESCAPE clause', () => {
    const result = buildWhereClause(columns, [
      { column: 'city', operator: 'starts_with', value: 'New' },
    ])
    expect(result).toBe(`WHERE CAST("city" AS VARCHAR) ILIKE 'New%' ESCAPE '$'`)
  })

  it('builds ends_with filter with ESCAPE clause', () => {
    const result = buildWhereClause(columns, [
      { column: 'name', operator: 'ends_with', value: 'son' },
    ])
    expect(result).toBe(`WHERE CAST("name" AS VARCHAR) ILIKE '%son' ESCAPE '$'`)
  })

  it('combines multiple filters with AND', () => {
    const result = buildWhereClause(columns, [
      { column: 'name', operator: 'eq', value: 'Alice' },
      { column: 'city', operator: 'contains', value: 'York' },
    ])
    expect(result).toContain('AND')
    expect(result).toContain(`CAST("name" AS VARCHAR) = 'Alice'`)
    expect(result).toContain(`CAST("city" AS VARCHAR) ILIKE '%York%'`)
  })

  it('ignores filters for non-existent columns', () => {
    const result = buildWhereClause(columns, [
      { column: 'nonexistent', operator: 'eq', value: 'test' },
    ])
    expect(result).toBe('')
  })

  it('ignores filters with empty value', () => {
    const result = buildWhereClause(columns, [{ column: 'name', operator: 'eq', value: '' }])
    expect(result).toBe('')
  })

  it('builds full-text search across all columns', () => {
    const result = buildWhereClause(columns, undefined, 'test')
    expect(result).toContain('CAST("name" AS VARCHAR) ILIKE')
    expect(result).toContain('CAST("city" AS VARCHAR) ILIKE')
    expect(result).toContain('CAST("age" AS VARCHAR) ILIKE')
    expect(result).toContain(' OR ')
  })

  it('combines filters and search with AND', () => {
    const result = buildWhereClause(
      columns,
      [{ column: 'name', operator: 'eq', value: 'Alice' }],
      'test'
    )
    expect(result).toMatch(/^WHERE .+ AND \(/)
  })

  it('escapes special characters in filter values', () => {
    const result = buildWhereClause(columns, [
      { column: 'name', operator: 'contains', value: "it's 100%" },
    ])
    expect(result).toContain("it''s 100$%")
    expect(result).toContain("ESCAPE '$'")
  })

  it('escapes _ in ILIKE patterns', () => {
    const result = buildWhereClause(columns, [
      { column: 'name', operator: 'contains', value: 'foo_bar' },
    ])
    expect(result).toContain('foo$_bar')
  })
})

describe('buildQuery', () => {
  const fileName = 'preview_123.parquet'
  const columns = ['name', 'city']

  it('builds basic query with pagination', () => {
    const { dataSQL, countSQL } = buildQuery(fileName, columns, {
      page: 0,
      pageSize: 100,
    })
    expect(dataSQL).toContain(`SELECT * FROM '${fileName}'`)
    expect(dataSQL).toContain('LIMIT 100 OFFSET 0')
    expect(dataSQL).not.toContain('WHERE')
    expect(dataSQL).not.toContain('ORDER BY')
    expect(countSQL).toContain(`SELECT COUNT(*) AS cnt FROM '${fileName}'`)
  })

  it('includes ORDER BY for valid sort column', () => {
    const { dataSQL } = buildQuery(fileName, columns, {
      sort: { column: 'name', direction: 'ASC' },
      page: 0,
      pageSize: 50,
    })
    expect(dataSQL).toContain('ORDER BY "name" ASC')
    expect(dataSQL).toContain('LIMIT 50 OFFSET 0')
  })

  it('ignores sort for non-existent column', () => {
    const { dataSQL } = buildQuery(fileName, columns, {
      sort: { column: 'nonexistent', direction: 'DESC' },
      page: 0,
      pageSize: 100,
    })
    expect(dataSQL).not.toContain('ORDER BY')
  })

  it('calculates correct offset for page', () => {
    const { dataSQL } = buildQuery(fileName, columns, {
      page: 3,
      pageSize: 100,
    })
    expect(dataSQL).toContain('OFFSET 300')
  })

  it('includes WHERE clause from filters', () => {
    const { dataSQL, countSQL } = buildQuery(fileName, columns, {
      filters: [{ column: 'name', operator: 'eq', value: 'Alice' }],
      page: 0,
      pageSize: 100,
    })
    expect(dataSQL).toContain('WHERE')
    expect(countSQL).toContain('WHERE')
  })
})
