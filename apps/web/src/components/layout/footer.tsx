import { Separator } from '@kukan/ui'

export function Footer() {
  return (
    <footer className="mt-auto">
      <Separator />
      <div className="mx-auto max-w-[var(--kukan-container-max-width)] px-4 py-6">
        <p className="text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} KUKAN
        </p>
      </div>
    </footer>
  )
}
