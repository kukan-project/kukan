'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@kukan/ui'

export default function Error({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('error')

  return (
    <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] flex-col items-center justify-center gap-4 px-4 py-24">
      <h1 className="text-6xl font-bold text-muted-foreground">500</h1>
      <p className="text-lg text-muted-foreground">{t('serverError')}</p>
      <Button onClick={() => reset()}>{t('backToHome')}</Button>
    </div>
  )
}
