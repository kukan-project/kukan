'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@kukan/ui'
import { passwordLengthSchema } from '@kukan/shared'
import { PASSWORD_LENGTH_KEYS, passwordLengthArgs } from '@/lib/password-messages'
import { changePassword } from '@/lib/auth-client'
import { PasswordField } from '@/components/password-field'
import { PasswordStrengthMeter } from '@/components/password-strength-meter'
import { useUser } from '@/components/dashboard/user-provider'

// Messages are i18n keys under the `profile` namespace, resolved at render time
const passwordSchema = z
  .object({
    // Length is not checked here: an account whose password predates the
    // policy would be locked out of the form that lets it move off one
    currentPassword: z.string().min(1, 'passwordRequired'),
    newPassword: passwordLengthSchema(PASSWORD_LENGTH_KEYS),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    // The `password` namespace, like the length rules: one field, one translator
    message: 'unchanged',
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'passwordMismatch',
  })

type PasswordValues = z.infer<typeof passwordSchema>

/** Self-service password change — current password required, no email involved. */
export function PasswordChangeCard() {
  const t = useTranslations('profile')
  const tp = useTranslations('password')
  const user = useUser()
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
  })

  /** What the server refused, in the words of whichever namespace owns it */
  const refusal = (code: string | undefined) => {
    if (code === 'INVALID_PASSWORD') return t('currentPasswordIncorrect')
    if (code === 'PASSWORD_TOO_WEAK') return tp('tooWeak')
    if (code === 'PASSWORD_TOO_LONG')
      return tp(PASSWORD_LENGTH_KEYS.tooLong, passwordLengthArgs(PASSWORD_LENGTH_KEYS.tooLong))
    return t('passwordChangeFailed')
  }

  // Mounting the meter costs a settings request, so it waits for a keystroke
  const newPassword = watch('newPassword') ?? ''

  const onSubmit = async (values: PasswordValues) => {
    setError(null)
    setChanged(false)
    const result = await changePassword({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
      // A password change is also how a user reacts to a suspected compromise;
      // the server re-issues this session's cookie, so only others are dropped
      revokeOtherSessions: true,
    })
    if (result.error) {
      setError(refusal(result.error.code))
      return
    }
    reset()
    setChanged(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('passwordTitle')}</CardTitle>
        {/* Prose reads across the card; the inputs below stay narrow */}
        <CardDescription>{t('passwordDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex max-w-md flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {changed && (
            <Alert variant="success" role="status">
              <AlertDescription>{t('passwordChanged')}</AlertDescription>
            </Alert>
          )}
          <PasswordField
            id="currentPassword"
            label={t('currentPassword')}
            autoComplete="current-password"
            error={
              errors.currentPassword && t(errors.currentPassword.message ?? 'passwordRequired')
            }
            {...register('currentPassword')}
          />
          <div className="flex flex-col gap-2">
            <PasswordField
              id="newPassword"
              label={t('newPassword')}
              autoComplete="new-password"
              error={
                errors.newPassword &&
                tp(
                  errors.newPassword.message ?? PASSWORD_LENGTH_KEYS.tooShort,
                  passwordLengthArgs(errors.newPassword.message)
                )
              }
              {...register('newPassword')}
            />
            {newPassword && <PasswordStrengthMeter password={newPassword} account={user} />}
          </div>
          <PasswordField
            id="confirmPassword"
            label={t('confirmPassword')}
            autoComplete="new-password"
            error={
              errors.confirmPassword && t(errors.confirmPassword.message ?? 'passwordMismatch')
            }
            {...register('confirmPassword')}
          />
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? t('changingPassword') : t('changePassword')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
