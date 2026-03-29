import { describe, it, expect } from 'vitest'
import { isUuid, escapeLike, SESSION_COOKIE_NAME } from '../utils'

describe('isUuid', () => {
  it('should return true for valid UUIDs', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(isUuid('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF')).toBe(true)
  })

  it('should be case-insensitive', () => {
    expect(isUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true)
    expect(isUuid('550e8400-E29B-41d4-a716-446655440000')).toBe(true)
  })

  it('should return false for non-UUID strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid('550e8400e29b41d4a716446655440000')).toBe(false) // no dashes
    expect(isUuid('550e8400-e29b-41d4-a716')).toBe(false) // too short
    expect(isUuid('550e8400-e29b-41d4-a716-44665544000g')).toBe(false) // invalid char
  })

  it('should return false for slug-like strings', () => {
    expect(isUuid('my-dataset-name')).toBe(false)
    expect(isUuid('test-organization')).toBe(false)
  })
})

describe('escapeLike', () => {
  it('should escape percent wildcard', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('%search%')).toBe('\\%search\\%')
  })

  it('should escape underscore wildcard', () => {
    expect(escapeLike('file_name')).toBe('file\\_name')
  })

  it('should escape backslash', () => {
    expect(escapeLike('path\\to')).toBe('path\\\\to')
  })

  it('should escape multiple special characters', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\')
  })

  it('should return input unchanged when no special characters', () => {
    expect(escapeLike('normal text')).toBe('normal text')
    expect(escapeLike('')).toBe('')
  })
})

describe('SESSION_COOKIE_NAME', () => {
  it('should be the expected cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('better-auth.session_token')
  })
})
