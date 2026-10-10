'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  evaluatePassword,
  passwordLength,
  passwordUserInputs,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  type PasswordStrength,
} from '@kukan/shared'
import { cn } from '@kukan/ui'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useSiteSettings } from '@/hooks/use-site-settings'

const SCORE_LABELS = ['veryWeak', 'weak', 'fair', 'good', 'strong'] as const
const SCORE_COLORS = ['bg-destructive', 'bg-destructive', 'bg-warning', 'bg-success', 'bg-success']

interface Props {
  password: string
  /** The account the password is for — it must not be derived from these */
  account?: { name?: string | null; email?: string | null; displayName?: string | null }
}

/**
 * Strength feedback for a password field. Judges by the score floor the
 * deployment enforces rather than the built-in default, so it cannot pass a
 * password the server is about to refuse. The dictionaries weigh several MB, so
 * `evaluatePassword` imports them on demand — nothing loads until something is
 * typed.
 */
export function PasswordStrengthMeter({ password, account }: Props) {
  const t = useTranslations('password')
  const locale = useLocale()
  const { passwordMinScore } = useSiteSettings()
  const [strength, setStrength] = useState<PasswordStrength | null>(null)

  // Scoring blocks the main thread and the reading below is a live region, so
  // every input it depends on settles first — including the account fields,
  // which are live-watched and would otherwise re-score on each keystroke in
  // a field that has nothing to do with the meter
  const scored = useDebouncedValue(password, 200)
  const name = useDebouncedValue(account?.name ?? '', 200)
  const email = useDebouncedValue(account?.email ?? '', 200)
  const displayName = useDebouncedValue(account?.displayName ?? '', 200)

  useEffect(() => {
    // Nothing is said until the deployment's floor is known: scoring against
    // the built-in default would pass a password a stricter server refuses,
    // and a reading that flips once the settings land is worse than a late one
    if (!scored || passwordMinScore === null) {
      setStrength(null)
      return
    }
    let current = true
    evaluatePassword(scored, {
      userInputs: passwordUserInputs({ name, email, displayName }),
      locale: locale === 'ja' ? 'ja' : 'en',
      minScore: passwordMinScore,
    })
      .then((result) => {
        if (current) setStrength(result)
      })
      .catch(() => {
        // Feedback is advisory; the server gates on the same policy either way
      })
    return () => {
      current = false
    }
  }, [scored, name, email, displayName, locale, passwordMinScore])

  // A cleared field drops the reading without waiting for the debounce
  if (!password || !strength) return null

  const barColor = SCORE_COLORS[strength.score]
  const lengthNote =
    passwordLength(password) < PASSWORD_MIN_LENGTH
      ? t('tooShort', { length: PASSWORD_MIN_LENGTH })
      : password.length > PASSWORD_MAX_LENGTH
        ? t('tooLong', { length: PASSWORD_MAX_LENGTH })
        : // A password that passes needs no advice. The floor is already the
          // length the policy asks for, so what is left is predictability
          !strength.acceptable
          ? t('addWords')
          : null
  const notes = [lengthNote, strength.warning, ...strength.suggestions].filter(
    (note): note is string => !!note
  )

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1" aria-hidden="true">
        {SCORE_LABELS.map((_, step) => (
          <div
            key={step}
            className={cn(
              'h-1 flex-1 rounded-full',
              step <= strength.score ? barColor : 'bg-muted'
            )}
          />
        ))}
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        {t('strength', { level: t(SCORE_LABELS[strength.score]) })}
      </p>
      {notes.map((note) => (
        <p key={note} className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  )
}
