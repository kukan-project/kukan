import { describe, it, expect } from 'vitest'
import { assertReadOnlySql } from '../../../services/query/sql-guard'
import { ValidationError } from '@kukan/shared'

describe('assertReadOnlySql', () => {
  it('accepts a simple SELECT', () => {
    expect(() => assertReadOnlySql('SELECT * FROM data')).not.toThrow()
  })

  it('accepts WITH (CTE) queries', () => {
    expect(() => assertReadOnlySql('WITH t AS (SELECT 1 AS n) SELECT n FROM t')).not.toThrow()
  })

  it('is case-insensitive on the leading keyword', () => {
    expect(() => assertReadOnlySql('sElEcT 1')).not.toThrow()
  })

  it('allows a single trailing semicolon', () => {
    expect(() => assertReadOnlySql('SELECT 1;')).not.toThrow()
    expect(() => assertReadOnlySql('SELECT 1;   ')).not.toThrow()
  })

  it('ignores leading comments when finding the keyword', () => {
    expect(() => assertReadOnlySql('-- comment\nSELECT 1')).not.toThrow()
    expect(() => assertReadOnlySql('/* c */ SELECT 1')).not.toThrow()
  })

  it('does not treat a semicolon inside a string literal as a separator', () => {
    expect(() => assertReadOnlySql("SELECT ';' AS x FROM data")).not.toThrow()
  })

  it('rejects multiple statements', () => {
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE data')).toThrow(ValidationError)
  })

  it('rejects a second statement hidden after a string literal', () => {
    expect(() => assertReadOnlySql("SELECT ';'; DROP TABLE data")).toThrow(ValidationError)
  })

  it.each([
    'DROP TABLE data',
    'INSERT INTO data VALUES (1)',
    'UPDATE data SET x = 1',
    'DELETE FROM data',
    'CREATE TABLE x (a int)',
    "ATTACH 'other.db'",
    "COPY data TO '/tmp/x.csv'",
    'INSTALL httpfs',
    'LOAD httpfs',
    'PRAGMA database_list',
    'SET enable_external_access=true',
  ])('rejects non-read-only statement: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ValidationError)
  })

  it('rejects DML disguised behind a leading comment', () => {
    expect(() => assertReadOnlySql('/* SELECT */ DELETE FROM data')).toThrow(ValidationError)
  })

  it.each([
    'WITH x AS (SELECT 1) DELETE FROM data',
    'WITH x AS (SELECT 1) INSERT INTO data VALUES (1)',
    'WITH x AS (SELECT 1) UPDATE data SET id = 0',
    'WITH x AS (SELECT 1) DROP TABLE data',
    "WITH x AS (SELECT 1) ATTACH 'other.db'",
    "WITH x AS (SELECT 1) COPY data TO '/tmp/x.csv'",
  ])('rejects a CTE wrapping a writing statement: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ValidationError)
  })

  it.each([
    'TRUNCATE data',
    'ALTER TABLE data ADD COLUMN c int',
    'VACUUM',
    'CHECKPOINT',
    'DETACH db1',
  ])('rejects other write/DDL statements: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ValidationError)
  })

  it.each([
    "SELECT replace(name, 'a', 'b') AS x FROM data", // replace() is a string function
    'SELECT * REPLACE (id + 1 AS id) FROM data', // star REPLACE modifier
    'SELECT id FROM data LIMIT 10 OFFSET 5', // OFFSET must not match \\bset\\b
    'SELECT created, updated_at FROM data', // columns containing keywords
    "SELECT id FROM data WHERE name = 'DROP TABLE'", // keyword inside a string literal
  ])('does not false-reject a legitimate read-only query: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow()
  })

  it('rejects empty / whitespace-only input', () => {
    expect(() => assertReadOnlySql('')).toThrow(ValidationError)
    expect(() => assertReadOnlySql('   \n  ')).toThrow(ValidationError)
  })
})
