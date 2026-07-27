import { describe, it, expect } from 'vitest'
import { assertSafeIdentifier, sqlLiteral } from '../sql'
import { lakeTableName } from '../table'

describe('sqlLiteral', () => {
  it('wraps in single quotes', () => {
    expect(sqlLiteral('s3://bucket/key.parquet')).toBe("'s3://bucket/key.parquet'")
  })

  it('doubles embedded quotes so the literal cannot be closed early', () => {
    expect(sqlLiteral("a'b")).toBe("'a''b'")
    expect(sqlLiteral("'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'")
  })
})

describe('assertSafeIdentifier', () => {
  it('accepts the identifiers we generate', () => {
    const table = lakeTableName('429ff69d-7b24-4a8f-a0ec-671bcceee31e')
    expect(assertSafeIdentifier(table)).toBe(table)
  })

  it.each(['res_1; DROP TABLE x', 'res-1', '1res', 'res 1', '', 'res_"x"'])(
    'rejects %j',
    (name) => {
      expect(() => assertSafeIdentifier(name)).toThrow(/Unsafe SQL identifier/)
    }
  )
})
