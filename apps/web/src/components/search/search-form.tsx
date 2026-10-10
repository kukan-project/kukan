import { useTranslations } from 'next-intl'
import { Button, Input } from '@kukan/ui'

/** Keyword search box. The input is uncontrolled, so a changed `defaultValue`
 *  alone never reaches the DOM: `key` remounts it when a client-side navigation
 *  changes the query while this form stays mounted (an example-query chip on
 *  /dataset), which would otherwise leave the previous query on screen. */
export function SearchForm({
  action,
  defaultValue,
  placeholder,
  hiddenParams,
}: {
  action: string
  defaultValue?: string
  placeholder?: string
  hiddenParams?: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('dataset')
  const tc = useTranslations('common')

  return (
    <form action={action} method="GET" className="flex gap-2">
      <Input
        key={defaultValue}
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder ?? t('searchPlaceholder')}
      />
      {hiddenParams &&
        Object.entries(hiddenParams).flatMap(([key, value]) => {
          if (!value) return []
          const values = Array.isArray(value) ? value : [value]
          return values.map((v, i) => (
            <input key={`${key}-${i}`} type="hidden" name={key} value={v} />
          ))
        })}
      <Button type="submit" size="sm">
        {tc('search')}
      </Button>
    </form>
  )
}
