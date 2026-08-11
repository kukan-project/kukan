'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '../../lib/utils'
import { Label } from './label'
import { Separator } from './separator'

type FieldContextValue = {
  controlId: string
  invalid: boolean
  describedBy: string | undefined
}

const FieldContext = React.createContext<FieldContextValue | null>(null)

/**
 * Null outside a `Field` on purpose: the parts stay usable on their own, they
 * just stop wiring themselves together.
 */
function useFieldContext() {
  return React.useContext(FieldContext)
}

function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        'flex flex-col gap-6',
        'has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
        className
      )}
      {...props}
    />
  )
}

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        'mb-3 font-medium',
        'data-[variant=legend]:text-base',
        'data-[variant=label]:text-sm',
        className
      )}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        'group/field-group @container/field-group flex w-full flex-col gap-7 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4',
        className
      )}
      {...props}
    />
  )
}

// No `data-[invalid=true]:text-destructive` here, unlike shadcn's: it colours
// the whole field, label included. An invalid field is marked by the control's
// ring and the message under it, both already destructive
const fieldVariants = cva('group/field flex w-full gap-3', {
  variants: {
    orientation: {
      // No `[&>*]:w-full` here, unlike shadcn's: every control we ship already
      // fills its field, and forcing the width onto every child leaves the
      // ones that must not stretch fighting the parent over utility order
      vertical: ['flex-col'],
      horizontal: [
        'flex-row items-center',
        '[&>[data-slot=field-label]]:flex-auto',
        'has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      ],
      responsive: [
        'flex-col @md/field-group:flex-row @md/field-group:items-center [&>*]:w-full @md/field-group:[&>*]:w-auto [&>.sr-only]:w-auto',
        '@md/field-group:[&>[data-slot=field-label]]:flex-auto',
        '@md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      ],
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
})

/**
 * Owns the ids of one field. The label points at the control, and the control
 * is described by the `description` and `error` given here — the field renders
 * both under its children, so an id is only ever referenced when the element
 * carrying it is on the page. Pass `id` when something outside the field has to
 * name the control.
 *
 * Help text and messages that describe a control belong in those two props.
 * `FieldDescription` and `FieldError` can still be placed among the children,
 * but nothing links them to the control.
 *
 * A field holding a set of controls rather than one — a row of toggles, a
 * repeater — has no label to point at, so it takes a `title` instead. The
 * group is then what is named and described, and its description introduces
 * the contents rather than trailing them.
 */
function Field({
  className,
  orientation = 'vertical',
  id,
  describedBy: externalDescribedBy,
  title,
  description,
  error,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> &
  VariantProps<typeof fieldVariants> & {
    /** ids of descriptions living outside this field, kept ahead of its own */
    describedBy?: string
    /** Names the group, for a field whose children are not one labelled control */
    title?: React.ReactNode
    description?: React.ReactNode
    error?: React.ReactNode
  }) {
  const generatedId = React.useId()
  const controlId = id ?? generatedId
  const titleId = `${controlId}-title`
  const descriptionId = `${controlId}-description`
  const errorId = `${controlId}-error`

  const value = React.useMemo<FieldContextValue>(
    () => ({
      controlId,
      // A message under the field is itself the claim that it is invalid
      invalid: !!error,
      describedBy:
        [externalDescribedBy, description && descriptionId, error && errorId]
          .filter(Boolean)
          .join(' ') || undefined,
    }),
    [controlId, descriptionId, errorId, externalDescribedBy, description, error]
  )

  const describing = description ? (
    <FieldDescription id={descriptionId}>{description}</FieldDescription>
  ) : null

  return (
    <FieldContext.Provider value={value}>
      <div
        role="group"
        data-slot="field"
        data-orientation={orientation}
        data-invalid={value.invalid || undefined}
        aria-labelledby={title ? titleId : undefined}
        // Named by its title, the group is what carries the description; with a
        // single control it is the control that does, through `FieldControl`.
        // `aria-invalid` has no such fallback — role=group does not support it,
        // which is why `data-invalid` above is the state a group exposes.
        aria-describedby={title ? value.describedBy : undefined}
        className={cn(fieldVariants({ orientation }), className)}
        {...props}
      >
        {title && <FieldTitle id={titleId}>{title}</FieldTitle>}
        {title && describing}
        {children}
        {!title && describing}
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    </FieldContext.Provider>
  )
}

/** The wiring a control may hold opinions about, and so has to be merged with */
type ControlAria = {
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
}

/**
 * Hands the field's id and aria wiring to whatever control it wraps — `Input`,
 * `Textarea`, `SelectTrigger` — so no form assembles those strings itself.
 */
function FieldControl({ children, ...props }: React.ComponentProps<typeof Slot.Root>) {
  const field = useFieldContext()

  // Slot lets the child's own props win, which for these two would mean a
  // control silently dropping the error it is meant to point at. The field's
  // wiring is merged onto the child instead: a control can add a description
  // of its own, and can call itself invalid, but cannot claim to be valid
  // while the field is showing a message.
  const control =
    field && React.isValidElement<ControlAria>(children)
      ? React.cloneElement(children, {
          'aria-invalid': field.invalid ? true : children.props['aria-invalid'],
          'aria-describedby':
            [field.describedBy, children.props['aria-describedby']].filter(Boolean).join(' ') ||
            undefined,
        })
      : children

  return (
    <Slot.Root id={field?.controlId} {...props}>
      {control}
    </Slot.Root>
  )
}

function FieldContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('group/field-content flex flex-1 flex-col gap-1.5 leading-snug', className)}
      {...props}
    />
  )
}

function FieldLabel({ className, htmlFor, ...props }: React.ComponentProps<typeof Label>) {
  const field = useFieldContext()

  return (
    <Label
      data-slot="field-label"
      htmlFor={htmlFor ?? field?.controlId}
      className={cn(
        'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50',
        'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-4',
        'has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 dark:has-data-[state=checked]:bg-primary/10',
        className
      )}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        'flex w-fit items-center gap-2 text-sm leading-snug font-medium group-data-[disabled=true]/field:opacity-50',
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        // text-xs, not shadcn's text-sm: help text sits under the control and
        // should not read as loud as the label above it
        'text-xs leading-normal font-normal text-muted-foreground group-has-[[data-orientation=horizontal]]/field:text-balance',
        'last:mt-0 nth-last-2:-mt-1 [[data-variant=legend]+&]:-mt-1.5',
        '[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
        className
      )}
      {...props}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        'relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2',
        className
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>
}) {
  const content = React.useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()]

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    )
  }, [children, errors])

  if (!content) {
    return null
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('text-sm font-normal text-destructive', className)}
      {...props}
    >
      {content}
    </div>
  )
}

export {
  Field,
  FieldControl,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
}
