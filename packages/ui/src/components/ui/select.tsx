'use client'

import * as React from 'react'
import { Select as SelectRoot } from 'radix-ui'
import { ChevronDown, Check } from 'lucide-react'

import { cn } from '../../lib/utils'

const Select = SelectRoot.Root
const SelectGroup = SelectRoot.Group
const SelectValue = SelectRoot.Value

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectRoot.Trigger>) {
  return (
    <SelectRoot.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2',
        className
      )}
      {...props}
    >
      {children}
      <SelectRoot.Icon asChild>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </SelectRoot.Icon>
    </SelectRoot.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectRoot.Content>) {
  return (
    <SelectRoot.Portal>
      <SelectRoot.Content
        data-slot="select-content"
        className={cn(
          'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        position={position}
        {...props}
      >
        <SelectRoot.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]'
          )}
        >
          {children}
        </SelectRoot.Viewport>
      </SelectRoot.Content>
    </SelectRoot.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectRoot.Label>) {
  return (
    <SelectRoot.Label
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-sm font-semibold', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectRoot.Item>) {
  return (
    <SelectRoot.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectRoot.ItemIndicator>
          <Check className="size-4" />
        </SelectRoot.ItemIndicator>
      </span>
      <SelectRoot.ItemText>{children}</SelectRoot.ItemText>
    </SelectRoot.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectRoot.Separator>) {
  return (
    <SelectRoot.Separator
      data-slot="select-separator"
      className={cn('-mx-1 my-1 h-px bg-muted', className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
}
