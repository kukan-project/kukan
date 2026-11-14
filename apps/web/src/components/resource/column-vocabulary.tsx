'use client'

import { Badge } from '@kukan/ui'
import { useTranslations } from 'next-intl'
import type { ColumnVocabulary, PublicColumnVocabulary } from '@kukan/shared'

/**
 * What a column's vocabulary is called (ADR-073): its concept, scheme and way
 * of writing, by the names the messages give them. An id the messages do not
 * name — a pack newer than the screen — is shown as it is.
 */
function useVocabularyLabel() {
  const t = useTranslations('resource.vocabulary')
  const name = (key: string, id: string) => (t.has(key) ? t(key) : id)
  return ({ concept, scheme, representation }: PublicColumnVocabulary) =>
    t('label', {
      concept: name(`concepts.${concept}`, concept),
      scheme: name(`schemes.${scheme}`, scheme),
      representation: name(`representations.${scheme}.${representation}`, representation),
    })
}

/** A decided vocabulary, as the public field list shows it: a badge, as the role is. */
export function ColumnVocabularyLabel({ vocabulary }: { vocabulary: PublicColumnVocabulary }) {
  const label = useVocabularyLabel()
  return (
    <Badge variant="outline" wrap>
      {label(vocabulary)}
    </Badge>
  )
}

/**
 * A column's vocabulary with what it rests on, for its editors: the share of
 * values that matched, the places matched against those of each level, and the
 * time the codes point to. A column left between schemes has a badge for each.
 */
export function ColumnVocabularyDetails({ vocabulary }: { vocabulary: ColumnVocabulary }) {
  const t = useTranslations('resource.vocabulary')
  const label = useVocabularyLabel()
  const shown = [
    vocabulary,
    // Recorded without one before candidates carried their concept
    ...(vocabulary.alternatives ?? []).map((a) => ({ concept: vocabulary.concept, ...a })),
  ]
  const when =
    vocabulary.periods.length === 0
      ? t('periodMixed')
      : vocabulary.periods.map((p) => periodText(t, p)).join(t('separator'))
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap gap-1">
        {shown.map((v) => (
          <Badge key={`${v.scheme}/${v.representation}`} variant="outline" wrap>
            {label(v)}
          </Badge>
        ))}
      </div>
      <span className="text-muted-foreground text-xs">
        {vocabulary.alternatives && (
          <>
            {t('candidates')}
            {t('separator')}
          </>
        )}
        {t('share', { percent: Math.round(vocabulary.share * 100) })}
        {vocabulary.levels.map(({ level, matched, total }) => (
          <span key={level}>
            {t('separator')}
            {t('level', { level, matched, total })}
          </span>
        ))}
        {t('separator')}
        {when}
      </span>
    </div>
  )
}

/** One span the codes point to, in the words of the scheme's time. */
function periodText(
  t: ReturnType<typeof useTranslations<'resource.vocabulary'>>,
  { validFrom: from, validTo: to }: ColumnVocabulary['periods'][number]
): string {
  if (from && to) return t('periodRange', { from, to })
  if (from) return t('periodFrom', { from })
  if (to) return t('periodTo', { to })
  return t('periodNow')
}
