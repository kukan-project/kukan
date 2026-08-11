'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@kukan/ui'
import { userNameSchema, passwordLengthSchema } from '@kukan/shared'
import { signUp } from '@/lib/auth-client'
import { PASSWORD_LENGTH_KEYS, passwordLengthArgs } from '@/lib/password-messages'
import { PasswordField } from '@/components/password-field'
import { PasswordStrengthMeter } from '@/components/password-strength-meter'
import { useSiteSettings } from '@/hooks/use-site-settings'

const signUpSchema = z.object({
  name: userNameSchema,
  email: z.email(),
  password: passwordLengthSchema(PASSWORD_LENGTH_KEYS),
})

type SignUpValues = z.infer<typeof signUpSchema>

export default function SignUpPage() {
  const t = useTranslations('auth')
  const tp = useTranslations('password')
  const [error, setError] = useState<string | null>(null)
  const { registrationEnabled } = useSiteSettings()

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
  })

  const account = { name: watch('name'), email: watch('email') }
  // Mounting the meter costs a settings request, so it waits for a keystroke
  const password = watch('password') ?? ''

  const onSubmit = async (values: SignUpValues) => {
    setError(null)
    const result = await signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    })
    if (result.error) {
      // The strength policy is the server's call — its threshold is deployment
      // specific, so the meter advises but never blocks the submit
      setError(result.error.code === 'PASSWORD_TOO_WEAK' ? tp('tooWeak') : t('signUpFailed'))
      return
    }
    window.location.href = '/dashboard'
  }

  if (registrationEnabled === null) {
    return null
  }

  if (!registrationEnabled) {
    return (
      <div className="flex min-h-[calc(100vh-var(--kukan-header-height)-64px)] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('signUp')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{t('registrationDisabled')}</p>
          </CardContent>
          <CardFooter className="justify-center">
            <p className="text-sm text-muted-foreground">
              {t('hasAccount')}{' '}
              <Link
                href="/auth/sign-in"
                className="text-primary underline-offset-4 hover:underline"
              >
                {t('signIn')}
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-var(--kukan-header-height)-64px)] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('signUp')}</CardTitle>
          <CardDescription>{t('signUpDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t('name')}</Label>
              <Input
                id="name"
                type="text"
                placeholder={t('namePlaceholder')}
                autoComplete="username"
                {...register('name')}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? 'name-error' : undefined}
              />
              {errors.name && (
                <p id="name-error" className="text-sm text-destructive">
                  {t('nameError')}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t('email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@example.com"
                autoComplete="email"
                {...register('email')}
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
              />
              {errors.email && (
                <p id="email-error" className="text-sm text-destructive">
                  {t('invalidEmail')}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <PasswordField
                id="password"
                label={t('password')}
                autoComplete="new-password"
                error={
                  errors.password &&
                  tp(
                    errors.password.message ?? PASSWORD_LENGTH_KEYS.tooShort,
                    passwordLengthArgs(errors.password.message)
                  )
                }
                {...register('password')}
              />
              {password && <PasswordStrengthMeter password={password} account={account} />}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('signingUp') : t('signUpButton')}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <p className="text-sm text-muted-foreground">
            {t('hasAccount')}{' '}
            <Link href="/auth/sign-in" className="text-primary underline-offset-4 hover:underline">
              {t('signIn')}
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
