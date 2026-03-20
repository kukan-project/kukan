import { Input, Label, Textarea } from '@kukan/ui'
import { useTranslations } from 'next-intl'

interface ResourceFormFieldsProps {
  /** Unique prefix for htmlFor ids (e.g. "res", "edit") */
  idPrefix: string
  name: string
  onNameChange: (value: string) => void
  format: string
  onFormatChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  /** Source section (URL input or file drop zone) — inserted between Name and Description */
  children: React.ReactNode
}

export function ResourceFormFields({
  idPrefix,
  name,
  onNameChange,
  format,
  onFormatChange,
  description,
  onDescriptionChange,
  children,
}: ResourceFormFieldsProps) {
  const t = useTranslations('resource')
  const tc = useTranslations('common')

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-name`}>{tc('name')}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('namePlaceholder')}
        />
      </div>
      {children}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-description`}>{tc('description')}</Label>
        <Textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={2}
          placeholder={t('descriptionPlaceholder')}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-format`}>{tc('format')}</Label>
        <Input
          id={`${idPrefix}-format`}
          value={format}
          onChange={(e) => onFormatChange(e.target.value)}
          placeholder={t('formatAutoDetected')}
        />
      </div>
    </>
  )
}
