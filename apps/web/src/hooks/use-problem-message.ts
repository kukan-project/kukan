'use client'

import { useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  problemTypeOf,
  validationMessageKey,
  type DraftPublishBlocker,
  type ProblemDetail,
  type ProblemType,
} from '@kukan/shared'
import type { MembershipRole } from './use-my-roles'

/** `package-name-taken` → `packageNameTaken`, the key its message sits under. */
function messageKey(type: ProblemType): string {
  return type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** Listed in form order; a blocker added in shared fails to compile here until it is placed. */
const PUBLISH_BLOCKERS = Object.keys({ name: 0, org: 0, license: 0 } satisfies Record<
  DraftPublishBlocker,
  0
>) as DraftPublishBlocker[]
const ROLES: readonly MembershipRole[] = ['admin', 'editor', 'member']
const ENTITIES = ['organization', 'group'] as const

/**
 * A request-validation failure, when every issue carries a shared schema's
 * message: `url: <translated>`, as the API's own `detail` reads in English.
 */
function translatedIssues(
  details: Record<string, unknown>,
  translate: (message: string) => string | undefined
): string | undefined {
  if (!Array.isArray(details.issues) || details.issues.length === 0) return undefined
  const parts: string[] = []
  for (const issue of details.issues as { path?: unknown; message?: unknown }[]) {
    const message = typeof issue.message === 'string' ? translate(issue.message) : undefined
    if (!message) return undefined
    const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
    parts.push(path ? `${path}: ${message}` : message)
  }
  return parts.join(', ')
}

/**
 * The message to show for an API failure: the translation when the refusal is
 * one the API names (`type`) or a validation failure raised by a shared schema,
 * otherwise its English `detail`, otherwise undefined for the caller's own
 * fallback.
 */
export function useProblemMessage() {
  const t = useTranslations('problem')
  const tv = useTranslations('validation')
  const locale = useLocale()

  return useCallback(
    (problem: ProblemDetail | null | undefined): string | undefined => {
      const type = problemTypeOf(problem?.type)
      const details = problem?.details ?? {}
      if (type === 'publish-blocked') {
        const blockers = Array.isArray(details.blockers) ? details.blockers : []
        const fields = PUBLISH_BLOCKERS.filter((b) => blockers.includes(b)).map((b) =>
          t(`publishBlockerField.${b}`)
        )
        if (fields.length > 0) {
          const list = new Intl.ListFormat(locale, { type: 'conjunction' }).format(fields)
          return t('publishBlocked', { fields: list })
        }
      } else if (type) {
        const role = ROLES.find((r) => r === details.role) ?? 'member'
        const entity = ENTITIES.find((e) => e === details.entity) ?? 'organization'
        return t(messageKey(type), {
          role: t(`roleName.${role}`),
          entity: t(`entityName.${entity}`),
          section: String(details.section ?? ''),
        })
      }
      const issues = translatedIssues(details, (message) => {
        const key = validationMessageKey(message)
        return key && tv(key)
      })
      return issues ?? (problem?.detail || undefined)
    },
    [t, tv, locale]
  )
}
