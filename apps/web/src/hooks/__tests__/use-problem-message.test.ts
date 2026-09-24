import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  VALIDATION_MESSAGES,
  problemTypeUri,
  type ProblemDetail,
  type ProblemType,
} from '@kukan/shared'
import { useProblemMessage } from '../use-problem-message'

function describeProblem(problem: ProblemDetail | undefined) {
  const { result } = renderHook(() => useProblemMessage())
  return result.current(problem)
}

function problem(
  type: ProblemType | 'about:blank',
  detail: string,
  details?: Record<string, unknown>
): ProblemDetail {
  return {
    type: type === 'about:blank' ? type : problemTypeUri(type),
    title: 'VALIDATION_ERROR',
    status: 400,
    detail,
    ...(details && { details }),
  }
}

describe('useProblemMessage', () => {
  it('translates a refusal the API names, rather than showing its English detail', () => {
    expect(describeProblem(problem('package-name-taken', 'Package name already exists'))).toBe(
      'This URL identifier is already in use'
    )
  })

  it('lists every publish blocker in one sentence', () => {
    const message = describeProblem(
      problem('publish-blocked', 'x; y', { blockers: ['license', 'name'] })
    )
    expect(message).toBe('Set the URL identifier and the license before publishing')
  })

  it('names the role an organization refusal asks for', () => {
    const message = describeProblem(
      problem('role-required', 'Requires editor role', { role: 'editor', entity: 'group' })
    )
    expect(message).toBe('This needs the editor role or higher in this category')
  })

  it("translates a request-validation failure raised by a shared schema's message", () => {
    const issues = [{ path: ['url'], message: VALIDATION_MESSAGES.httpOnly }]
    expect(describeProblem(problem('about:blank', 'url: …', { issues }))).toBe(
      'url: Use a URL that starts with http or https'
    )
  })

  it('keeps the English detail when any validation issue is not a shared message', () => {
    const issues = [
      { path: ['url'], message: VALIDATION_MESSAGES.httpOnly },
      { path: ['name'], message: 'Too small' },
    ]
    expect(describeProblem(problem('about:blank', 'url: x, name: Too small', { issues }))).toBe(
      'url: x, name: Too small'
    )
  })

  it('falls back to the English detail for a refusal it does not know', () => {
    expect(describeProblem(problem('about:blank', 'Resource not found: r1'))).toBe(
      'Resource not found: r1'
    )
  })

  it('leaves the wording to the caller when there is no reason to show', () => {
    expect(describeProblem(problem('about:blank', ''))).toBeUndefined()
    expect(describeProblem(undefined)).toBeUndefined()
  })
})
