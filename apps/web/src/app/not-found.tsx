import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button } from '@kukan/ui'

export default async function NotFound() {
  const t = await getTranslations('error')

  return (
    <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] flex-col items-center justify-center gap-4 px-4 py-24">
      <h1 className="text-6xl font-bold text-muted-foreground">404</h1>
      <p className="text-lg text-muted-foreground">{t('notFound')}</p>
      <Button asChild>
        <Link href="/">{t('backToHome')}</Link>
      </Button>
    </div>
  )
}
