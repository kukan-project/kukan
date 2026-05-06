import { describe, it, expect } from 'vitest'
import {
  KukanError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
} from '../errors'

describe('KukanError', () => {
  it('should create with code, status, and message', () => {
    const error = new KukanError('something went wrong', 'INTERNAL', 500)
    expect(error.message).toBe('something went wrong')
    expect(error.code).toBe('INTERNAL')
    expect(error.status).toBe(500)
    expect(error.details).toBeUndefined()
  })

  it('should accept optional details', () => {
    const details = { field: 'name', reason: 'duplicate' }
    const error = new KukanError('bad', 'BAD', 400, details)
    expect(error.details).toEqual(details)
  })

  it('should default status to 500', () => {
    const error = new KukanError('fail', 'FAIL')
    expect(error.status).toBe(500)
  })

  it('should be an instance of Error', () => {
    const error = new KukanError('test', 'TEST')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(KukanError)
  })

  it('should have name KukanError', () => {
    const error = new KukanError('test', 'TEST')
    expect(error.name).toBe('KukanError')
  })
})

describe('NotFoundError', () => {
  it('should create with entity and id', () => {
    const error = new NotFoundError('Package', 'my-dataset')
    expect(error.message).toBe('Package not found: my-dataset')
    expect(error.code).toBe('NOT_FOUND')
    expect(error.status).toBe(404)
  })

  it('should be an instance of KukanError', () => {
    const error = new NotFoundError('User', '123')
    expect(error).toBeInstanceOf(KukanError)
  })
})

describe('ValidationError', () => {
  it('should create with message', () => {
    const error = new ValidationError('Invalid input')
    expect(error.message).toBe('Invalid input')
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.status).toBe(400)
  })

  it('should accept optional details', () => {
    const error = new ValidationError('Name taken', { name: 'duplicate' })
    expect(error.details).toEqual({ name: 'duplicate' })
  })
})

describe('UnauthorizedError', () => {
  it('should have default message', () => {
    const error = new UnauthorizedError()
    expect(error.message).toBe('Authentication required')
    expect(error.code).toBe('UNAUTHORIZED')
    expect(error.status).toBe(401)
  })

  it('should accept custom message', () => {
    const error = new UnauthorizedError('Token expired')
    expect(error.message).toBe('Token expired')
  })
})

describe('ForbiddenError', () => {
  it('should have default message', () => {
    const error = new ForbiddenError()
    expect(error.message).toBe('Forbidden')
    expect(error.code).toBe('FORBIDDEN')
    expect(error.status).toBe(403)
  })

  it('should accept custom message', () => {
    const error = new ForbiddenError('Admin only')
    expect(error.message).toBe('Admin only')
  })
})

describe('ConflictError', () => {
  it('should have default message', () => {
    const error = new ConflictError()
    expect(error.message).toBe('Conflict')
    expect(error.code).toBe('CONFLICT')
    expect(error.status).toBe(409)
  })

  it('should accept custom message', () => {
    const error = new ConflictError('Resource already exists')
    expect(error.message).toBe('Resource already exists')
  })
})
