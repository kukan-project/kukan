'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@kukan/ui'
import { SwitchField } from '@/components/switch-field'
import { clientFetch } from '@/lib/client-api'

const SETTING_KEY = 'registration-enabled'

/** Self-registration on/off toggle (ADR-038) */
export function RegistrationCard() {
  const t = useTranslations('dashboard.adminSite')
  const tc = useTranslations('common')

  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await clientFetch('/api/v1/admin/settings')
        if (res.ok) {
          const data: Record<string, unknown> = await res.json()
          const value = data[SETTING_KEY] === true
          setEnabled(value)
          setSelected(value)
          setLoaded(true)
        }
      } catch {
        // ignore — card stays hidden
      }
    })()
  }, [])

  if (!loaded) return null

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await clientFetch(`/api/v1/admin/settings/${SETTING_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: selected }),
      })
      if (res.ok) {
        const data: { value: boolean } = await res.json()
        setEnabled(data.value)
        setSelected(data.value)
        setSaved(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('registrationTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('registrationDescription')}</p>
        <SwitchField
          label={t('registrationLabel')}
          checked={selected}
          onCheckedChange={(checked) => {
            setSelected(checked)
            setSaved(false)
          }}
        />
        <div className="flex items-center gap-4">
          <Button onClick={save} disabled={saving || selected === enabled}>
            {tc('save')}
          </Button>
          {saved && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
