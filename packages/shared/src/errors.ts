/**
 * KUKAN Error Classes
 * RFC 7807 Problem Details compatible errors
 */

export class KukanError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'KukanError'
  }
}

export class NotFoundError extends KukanError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404)
  }
}

export class ValidationError extends KukanError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details)
  }
}

export class UnauthorizedError extends KukanError {
  constructor(message = 'Authentication required') {
    super(message, 'UNAUTHORIZED', 401)
  }
}

export class ForbiddenError extends KukanError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN', 403)
  }
}

export class ConflictError extends KukanError {
  constructor(message = 'Conflict') {
    super(message, 'CONFLICT', 409)
  }
}

export class RequestTimeoutError extends KukanError {
  constructor(message = 'Request timed out') {
    super(message, 'REQUEST_TIMEOUT', 408)
  }
}

export class TooManyRequestsError extends KukanError {
  constructor(message = 'Too many requests') {
    super(message, 'TOO_MANY_REQUESTS', 429)
  }
}

export class ServiceUnavailableError extends KukanError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 'SERVICE_UNAVAILABLE', 503)
  }
}
