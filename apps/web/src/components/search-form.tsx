import { Button, Input } from '@kukan/ui'

export function SearchForm({
  action,
  defaultValue,
  placeholder = 'データセットを検索...',
}: {
  action: string
  defaultValue?: string
  placeholder?: string
}) {
  return (
    <form action={action} method="GET" className="flex gap-2">
      <Input name="q" type="search" defaultValue={defaultValue} placeholder={placeholder} />
      <Button type="submit" size="sm">
        検索
      </Button>
    </form>
  )
}
