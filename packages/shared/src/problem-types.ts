/**
 * The refusals a client can tell apart (RFC 9457 `type`).
 *
 * The status and the coarse `title` code say only what kind of refusal it was;
 * two different 400s look the same through them. A screen that has to say what
 * went wrong in the reader's language keys on one of these instead of on the
 * English `detail`, which stays for API callers and the logs.
 */
export const PROBLEM_TYPES = [
  'package-name-taken',
  'publish-blocked',
  'restore-organization-inactive',
  'publish-organization-inactive',
  'package-state-changed',
  'organization-name-taken',
  'organization-has-active-packages',
  'group-name-taken',
  'user-has-linked-packages',
  'user-not-deleted',
  'draft-access-denied',
  'role-required',
  'sysadmin-required',
  'owner-or-sysadmin-required',
  'upload-superseded',
  'upload-not-pending',
  'section-duplicated',
] as const

export type ProblemType = (typeof PROBLEM_TYPES)[number]

/** Identifiers, not documents: nothing is served at these addresses. */
const PROBLEM_TYPE_BASE = 'https://kukan.dev/problems/'

export function problemTypeUri(type: ProblemType): string {
  return PROBLEM_TYPE_BASE + type
}

/** The problem type a response's `type` names, or undefined for any other value. */
export function problemTypeOf(uri: unknown): ProblemType | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(PROBLEM_TYPE_BASE)) return undefined
  const type = uri.slice(PROBLEM_TYPE_BASE.length)
  return (PROBLEM_TYPES as readonly string[]).includes(type) ? (type as ProblemType) : undefined
}
