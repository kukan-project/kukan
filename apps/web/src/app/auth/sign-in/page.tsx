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
  Field,
  FieldControl,
  FieldLabel,
  Input,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@kukan/ui'
import { signIn } from '@/lib/auth-client'
import { PasswordField } from '@/components/password-field'
import { useSiteSettings } from '@/hooks/use-site-settings'

const signInSchema = z.object({
  email: z.email(),
  // Presence only. What length the account's password has to be was decided
  // when it was set; guessing it here would refuse a sign-in the server accepts
  password: z.string().min(1),
})

type SignInValues = z.infer<typeof signInSchema>

export default function SignInPage() {
  const t = useTranslations('auth')
  const [error, setError] = useState<string | null>(null)
  const { registrationEnabled } = useSiteSettings()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
  })

  const onSubmit = async (values: SignInValues) => {
    setError(null)
    const result = await signIn.email({
      email: values.email,
      password: values.password,
    })
    if (result.error) {
      setError(t('invalidCredentials'))
      return
    }
    window.location.href = '/dashboard'
  }

  return (
    <div className="flex min-h-[calc(100vh-var(--kukan-header-height)-64px)] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('signIn')}</CardTitle>
          <CardDescription>{t('signInDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Field id="email" error={errors.email && t('invalidEmail')}>
              <FieldLabel>{t('email')}</FieldLabel>
              <FieldControl>
                <Input
                  type="email"
                  placeholder="name@example.com"
                  autoComplete="email"
                  {...register('email')}
                />
              </FieldControl>
            </Field>
            <PasswordField
              id="password"
              label={t('password')}
              autoComplete="current-password"
              error={errors.password && t('passwordRequired')}
              {...register('password')}
            />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('signingIn') : t('signIn')}
            </Button>
          </form>
        </CardContent>
        {registrationEnabled && (
          <CardFooter className="justify-center">
            <p className="text-sm text-muted-foreground">
              {t('noAccount')}{' '}
              <Link
                href="/auth/sign-up"
                className="text-primary underline-offset-4 hover:underline"
              >
                {t('signUp')}
              </Link>
            </p>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
