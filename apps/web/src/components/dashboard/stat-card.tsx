import { Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'

interface StatCardProps {
  label: string
  value?: number
  variant?: 'destructive'
  active?: boolean
  onClick?: () => void
}

export function StatCard({ label, value, variant, active, onClick }: StatCardProps) {
  return (
    <Card
      className={`${onClick ? 'cursor-pointer' : ''} transition-colors hover:border-primary/50 ${active ? 'border-primary bg-primary/5 ring-2 ring-primary/25' : ''}`}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`text-3xl font-bold ${variant === 'destructive' && value ? 'text-destructive' : ''}`}
        >
          {value ?? '-'}
        </p>
      </CardContent>
    </Card>
  )
}
