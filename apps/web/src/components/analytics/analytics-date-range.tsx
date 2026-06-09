'use client'

import { useTranslations } from 'next-intl'
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kukan/ui'

type Preset = '7d' | '30d' | '90d' | '1y' | 'custom'

const PRESET_MAP: Record<Exclude<Preset, 'custom'>, { startDate: string; endDate: string }> = {
  '7d': { startDate: '7daysAgo', endDate: 'today' },
  '30d': { startDate: '30daysAgo', endDate: 'today' },
  '90d': { startDate: '90daysAgo', endDate: 'today' },
  '1y': { startDate: '365daysAgo', endDate: 'today' },
}

export const DEFAULT_DATE_RANGE = PRESET_MAP['30d']

function detectPreset(startDate: string): Preset {
  for (const [key, val] of Object.entries(PRESET_MAP)) {
    if (val.startDate === startDate) return key as Preset
  }
  return 'custom'
}

export function AnalyticsDateRange({
  startDate,
  endDate,
  onRangeChange,
}: {
  startDate: string
  endDate: string
  onRangeChange: (startDate: string, endDate: string) => void
}) {
  const t = useTranslations('dashboard.adminAnalytics')
  const preset = detectPreset(startDate)

  const handlePresetChange = (value: string) => {
    const p = value as Preset
    if (p === 'custom') {
      // Switch to custom with today's dates
      const today = new Date().toISOString().slice(0, 10)
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
      onRangeChange(weekAgo, today)
    } else {
      const range = PRESET_MAP[p]
      onRangeChange(range.startDate, range.endDate)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={preset} onValueChange={handlePresetChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7d">{t('dateRange7d')}</SelectItem>
          <SelectItem value="30d">{t('dateRange30d')}</SelectItem>
          <SelectItem value="90d">{t('dateRange90d')}</SelectItem>
          <SelectItem value="1y">{t('dateRange1y')}</SelectItem>
          <SelectItem value="custom">{t('dateRangeCustom')}</SelectItem>
        </SelectContent>
      </Select>

      {preset === 'custom' && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            className="w-[150px]"
            value={startDate}
            onChange={(e) => onRangeChange(e.target.value, endDate)}
          />
          <span className="text-muted-foreground">-</span>
          <Input
            type="date"
            className="w-[150px]"
            value={endDate}
            onChange={(e) => onRangeChange(startDate, e.target.value)}
          />
        </div>
      )}
    </div>
  )
}
