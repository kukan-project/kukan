import Link from 'next/link'
import { Pencil } from 'lucide-react'
import { Button, cn } from '@kukan/ui'

interface ManageLinkProps {
  /** The dashboard editor's page for what this public page shows */
  href: string
  label: string
  className?: string
}

/**
 * The public page's way into the editor (ADR-072 decision 7), for those who may
 * write the dataset. An icon, not a labelled button: the page should read the
 * same as it does to everyone else. Not prefetched: the resource explorer
 * changes the address with every resource picked, and few who see the icon go
 * on to press it.
 */
export function ManageLink({ href, label, className }: ManageLinkProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn('shrink-0 text-muted-foreground hover:text-foreground', className)}
      asChild
    >
      <Link href={href} prefetch={false} title={label} aria-label={label}>
        <Pencil />
      </Link>
    </Button>
  )
}
