'use client'

import type { ComponentProps, ReactNode } from 'react'
import { Field, FieldControl, FieldLabel, Switch, cn } from '@kukan/ui'

type Props = Omit<ComponentProps<typeof Switch>, 'id'> & {
  label: ReactNode
  id?: string
  className?: string
  labelClassName?: string
}

/**
 * A switch with its label beside it. Shrink-wrapped rather than filling the
 * field, so a row of settings reads as a list of statements rather than a form.
 */
export function SwitchField({ label, id, className, labelClassName, ...switchProps }: Props) {
  return (
    <Field orientation="horizontal" id={id} className={cn('w-fit gap-2', className)}>
      <FieldControl>
        <Switch {...switchProps} />
      </FieldControl>
      <FieldLabel className={cn('cursor-pointer font-normal', labelClassName)}>{label}</FieldLabel>
    </Field>
  )
}
