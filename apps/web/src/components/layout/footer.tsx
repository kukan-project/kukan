import { Separator } from '@kukan/ui'

const START_YEAR = 2026

export function Footer() {
  const currentYear = new Date().getFullYear()
  const yearDisplay = currentYear > START_YEAR ? `${START_YEAR}\u2013${currentYear}` : START_YEAR

  return (
    <footer className="mt-auto">
      <Separator />
      <div className="mx-auto flex max-w-[var(--kukan-container-max-width)] items-center justify-between px-4 py-6">
        <span className="font-[family-name:var(--font-display)] text-sm font-bold tracking-[1px]">
          KUKAN
        </span>
        <span className="text-xs text-muted-foreground">
          &copy; {yearDisplay} KUKAN Contributors. AGPL-3.0 License.
        </span>
      </div>
    </footer>
  )
}
