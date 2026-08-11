'use client'

import { useId, useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, cn } from '@kukan/ui'

type Props = Omit<ComponentProps<typeof Input>, 'type' | 'id'> & {
  label: string
  /** Rendered under the field when set; also marks the input invalid */
  error?: string
  id?: string
}

/**
 * A password input with a reveal toggle. Typing a passphrase blind is where
 * long passwords go wrong, and the strength meter is only useful next to what
 * it is describing.
 */
export function PasswordField({
  label,
  error,
  id,
  className,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...inputProps
}: Props) {
  const t = useTranslations('password')
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const errorId = `${fieldId}-error`
  const [revealed, setRevealed] = useState(false)

  // Both readings are true at once: a field can have requirements described
  // elsewhere and an error of its own, and aria-describedby takes a list
  const described = [describedBy, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="relative">
        {/* Caller props first: what this composes — the room the toggle needs,
            and the masking — is not the caller's to drop */}
        <Input
          {...inputProps}
          id={fieldId}
          type={revealed ? 'text' : 'password'}
          className={cn('pr-10', className)}
          aria-invalid={error ? true : invalid}
          aria-describedby={described || undefined}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setRevealed((shown) => !shown)}
          // Revealing is the user's own call about their surroundings, so the
          // state is announced rather than the field's contents
          aria-pressed={revealed}
          aria-label={revealed ? t('hide') : t('show')}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
