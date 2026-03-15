import { useTranslations } from 'next-intl'
import { Button, Input } from '@kukan/ui'

export function SearchForm({
  action,
  defaultValue,
  placeholder,
  hiddenParams,
}: {
  action: string
  defaultValue?: string
  placeholder?: string
  hiddenParams?: Record<string, string | undefined>
}) {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')

  return (
    <form action={action} method="GET" className="flex gap-2">
      <Input
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder ?? t('searchPlaceholder')}
      />
      {hiddenParams &&
        Object.entries(hiddenParams).map(
          ([key, value]) => value && <input key={key} type="hidden" name={key} value={value} />
        )}
      <Button type="submit" size="sm">
        {tc('search')}
      </Button>
    </form>
  )
}
