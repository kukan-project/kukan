import { describe, it, expect } from 'vitest'
import { sqlLogFields } from '../../../services/query/query-service'
import { QUERY_LOG_SQL_LENGTH } from '../../../config'

describe('sqlLogFields', () => {
  it('should log a short query whole', () => {
    expect(sqlLogFields('SELECT * FROM data')).toEqual({
      sql: 'SELECT * FROM data',
      sqlLength: 18,
    })
  })

  it('should cut a long query and keep its full length', () => {
    const sql = `SELECT '${'x'.repeat(5000)}' FROM data`
    const fields = sqlLogFields(sql)
    expect(fields.sql).toBe(`${sql.slice(0, QUERY_LOG_SQL_LENGTH)}…`)
    expect(fields.sqlLength).toBe(sql.length)
  })
})
