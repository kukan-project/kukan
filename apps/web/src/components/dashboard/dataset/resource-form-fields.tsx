import { Field, FieldControl, FieldLabel, Input, Textarea } from '@kukan/ui'
import { useTranslations } from 'next-intl'

interface ResourceFormFieldsProps {
  /** Unique prefix for the field ids (e.g. "res", "edit") */
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
      <Field id={`${idPrefix}-name`}>
        <FieldLabel>{tc('name')}</FieldLabel>
        <FieldControl>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('namePlaceholder')}
          />
        </FieldControl>
      </Field>
      {children}
      <Field id={`${idPrefix}-description`}>
        <FieldLabel>{tc('description')}</FieldLabel>
        <FieldControl>
          <Textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={2}
            placeholder={t('descriptionPlaceholder')}
          />
        </FieldControl>
      </Field>
      <Field id={`${idPrefix}-format`}>
        <FieldLabel>{tc('format')}</FieldLabel>
        <FieldControl>
          <Input
            value={format}
            onChange={(e) => onFormatChange(e.target.value)}
            placeholder={t('formatAutoDetected')}
          />
        </FieldControl>
      </Field>
    </>
  )
}
