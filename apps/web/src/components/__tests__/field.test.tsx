import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  Button,
  Field,
  FieldControl,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kukan/ui'

/**
 * The wiring `Field` took over from the forms: the ids, `aria-invalid` and
 * `aria-describedby` that every field used to assemble by hand.
 */
describe('Field', () => {
  it('points the label at the control without either being given an id', () => {
    render(
      <Field>
        <FieldLabel>Title</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>
    )

    expect(screen.getByLabelText('Title')).toBeInTheDocument()
  })

  it('describes the control by its help text, and stays valid without an error', () => {
    render(
      <Field id="name" description="Used in URLs">
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>
    )
    const input = screen.getByLabelText('Name')

    expect(input).toHaveAccessibleDescription('Used in URLs')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('adds the error to the description and marks the control invalid', () => {
    render(
      <Field id="name" description="Used in URLs" error="Too short">
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>
    )
    const input = screen.getByLabelText('Name')

    // Both readings are true at once, and aria-describedby takes a list
    expect(input).toHaveAttribute('aria-describedby', 'name-description name-error')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Too short')
  })

  it('keeps ids of descriptions living outside the field ahead of its own', () => {
    render(
      <Field id="pw" describedBy="requirements" error="Too short">
        <FieldLabel>Password</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>
    )

    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'aria-describedby',
      'requirements pw-error'
    )
  })

  it('wires an error that only appears once the form has been submitted', () => {
    function Harness() {
      const [error, setError] = useState<string | undefined>()
      return (
        <>
          <Field id="name" error={error}>
            <FieldLabel>Name</FieldLabel>
            <FieldControl>
              <Input />
            </FieldControl>
          </Field>
          <Button onClick={() => setError('Required')}>Submit</Button>
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByLabelText('Name')
    expect(input).not.toHaveAttribute('aria-describedby')

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(input).toHaveAttribute('aria-describedby', 'name-error')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('wires controls that are not inputs — a select trigger, a switch', () => {
    render(
      <>
        <Field id="license" error="Required">
          <FieldLabel>License</FieldLabel>
          <Select>
            <FieldControl>
              <SelectTrigger>
                <SelectValue placeholder="Pick one" />
              </SelectTrigger>
            </FieldControl>
            <SelectContent>
              <SelectItem value="cc-by">CC BY</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="horizontal">
          <FieldControl>
            <Switch />
          </FieldControl>
          <FieldLabel>Private</FieldLabel>
        </Field>
      </>
    )

    const trigger = screen.getByLabelText('License')
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(trigger).toHaveAttribute('aria-describedby', 'license-error')
    expect(screen.getByLabelText('Private')).toHaveAttribute('role', 'switch')
  })

  it('keeps its wiring when the control carries aria props of its own', () => {
    render(
      <Field id="name" description="Used in URLs" error="Too short">
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          {/* A control may add a description, but not call itself valid while
              the field is showing a message */}
          <Input aria-describedby="mine" aria-invalid={false} />
        </FieldControl>
      </Field>
    )
    const input = screen.getByLabelText('Name')

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', 'name-description name-error mine')
  })

  it('marks the field itself invalid, for styling that spans its parts', () => {
    const { rerender } = render(
      <Field id="name">
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>
    )
    expect(screen.getByRole('group')).not.toHaveAttribute('data-invalid')

    rerender(
      <Field id="name" error="Too short">
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>
    )
    expect(screen.getByRole('group')).toHaveAttribute('data-invalid', 'true')
  })

  it('names and describes the group, for a field that is not one control', () => {
    render(
      <Field title="Categories" description="Click to select">
        <button type="button" aria-pressed={false}>
          Transport
        </button>
      </Field>
    )
    const group = screen.getByRole('group', { name: 'Categories' })

    // The toggles belong to a named group, not to a label pointing at nothing,
    // and the hint describes that group since no single control owns it
    expect(group).toContainElement(screen.getByRole('button', { name: 'Transport' }))
    expect(group).toHaveAccessibleDescription('Click to select')
  })

  it('describes the group by its error too, and leads with the description', () => {
    render(
      <Field title="Custom Fields" description="Add pairs" error="Duplicate key">
        <input aria-label="key" />
      </Field>
    )
    const group = screen.getByRole('group', { name: 'Custom Fields' })

    expect(group).toHaveAccessibleDescription('Add pairs Duplicate key')
    // A group's description introduces its contents rather than trailing them
    const parts = [...group.children].map((el) => el.getAttribute('data-slot'))
    expect(parts.slice(0, 2)).toEqual(['field-label', 'field-description'])
  })

  it('lets the control keep an id of its own', () => {
    render(
      <Field id="generated">
        <FieldLabel htmlFor="mine">Name</FieldLabel>
        <FieldControl>
          <Input id="mine" />
        </FieldControl>
      </Field>
    )

    expect(screen.getByLabelText('Name')).toHaveAttribute('id', 'mine')
  })
})
