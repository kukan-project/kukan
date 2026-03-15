'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import {
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
import { signIn } from '@/lib/auth-client'

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

type SignInValues = z.infer<typeof signInSchema>

export default function SignInPage() {
  const t = useTranslations('auth')
  const [error, setError] = useState<string | null>(null)

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
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t('email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@example.com"
                autoComplete="email"
                {...register('email')}
                aria-invalid={!!errors.email}
              />
              {errors.email && <p className="text-sm text-destructive">{t('invalidEmail')}</p>}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password')}
                aria-invalid={!!errors.password}
              />
              {errors.password && (
                <p className="text-sm text-destructive">{t('passwordMinLength')}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('signingIn') : t('signIn')}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <p className="text-sm text-muted-foreground">
            {t('noAccount')}{' '}
            <Link href="/auth/sign-up" className="text-primary underline-offset-4 hover:underline">
              {t('signUp')}
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
