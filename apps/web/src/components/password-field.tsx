'use client'

import { useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  Field,
  FieldControl,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@kukan/ui'

type Props = Omit<ComponentProps<typeof InputGroupInput>, 'type' | 'id'> & {
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
  ...inputProps
}: Props) {
  const t = useTranslations('password')
  const [revealed, setRevealed] = useState(false)

  return (
    // A field can have requirements described elsewhere and an error of its
    // own; the caller's ids stay ahead of the one this field generates
    <Field id={id} describedBy={describedBy} error={error}>
      <FieldLabel>{label}</FieldLabel>
      {/* The caller's class sizes the control, which is the bordered group —
          on the input it would only shrink what sits inside the border */}
      <InputGroup className={className}>
        {/* Caller props first: the masking this composes is not theirs to drop */}
        <FieldControl>
          <InputGroupInput {...inputProps} type={revealed ? 'text' : 'password'} />
        </FieldControl>
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            onClick={() => setRevealed((shown) => !shown)}
            // Revealing is the user's own call about their surroundings, so the
            // state is announced rather than the field's contents
            aria-pressed={revealed}
            aria-label={revealed ? t('hide') : t('show')}
          >
            {revealed ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  )
}
