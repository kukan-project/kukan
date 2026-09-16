'use client'

import { useTranslations, useLocale, useTimeZone } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { Badge } from '@kukan/ui'
import type { ResourceSummaryMeta } from '@kukan/shared'
import { formatDate } from '@/components/date-time'
import { useSiteSettings } from '@/hooks/use-site-settings'

/**
 * Which sentence says how much of the file was read.
 *
 * "All of it" and "the first few rows of it" are different claims, and the
 * reader cannot tell them apart from the abstract — the model is forbidden to
 * mention the material at all, precisely because naming it explains nothing
 * (ADR-053 §7). So the extent is stated here, in the reader's terms.
 *
 * Abstracts written before the extent was recorded fall back to a sentence
 * with no quantity in it.
 */
function readKey(meta: ResourceSummaryMeta): string {
  const { material, coverage } = meta
  if (!material) return 'read.unknown'
  // A long PDF goes as its first pages rather than not at all (ADR-053 §3.6),
  // and that is the one original a reader must not take for the whole file.
  // Coverage is what tells them apart: an original that went whole carries
  // none, because "all of it" is what its absence already says.
  if (material === 'original') return coverage?.total ? 'read.originalPages' : 'read.original'
  if (material === 'image') return 'read.image'
  if (!coverage?.read) return 'read.unknown'
  if (material === 'schema') return coverage.total ? 'read.schema' : 'read.schemaNoTotal'
  if (material === 'files') return coverage.total ? 'read.files' : 'read.filesNoTotal'
  return `read.${material}`
}

interface Props {
  summary?: string | null
  summaryMeta?: ResourceSummaryMeta | null
  /** The version the resource serves now, to say when the abstract predates it */
  latestVersion?: number | null
}

/**
 * The AI-written abstract, with what it was made from (ADR-053 §7).
 *
 * **On screen it is called a description, not an abstract.** The precise word
 * is the one the ADR, the spec and these types use, and it is a librarian's —
 * a reader of the catalogue is not owed it. "Description" also claims nothing
 * about how much of the file was condensed, which matters here: most of these
 * are written from a part, and the line under them says which part.
 *
 * The notice names the material and the version, because those are what tell a
 * reader which part to check and whether the file has moved on since. "Written
 * by AI" on its own, left on a description of a file that was replaced a year
 * ago, is the worst form of this.
 *
 * A person's own text carries no notice: it is not a generated sentence, and
 * labelling it as one would be false.
 */
export function ResourceAbstract({ summary, summaryMeta, latestVersion }: Props) {
  const t = useTranslations('resourceAbstract')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const { resourceSummaryEnabled } = useSiteSettings()
  const meta = summaryMeta ?? {}

  // An editor who took the abstract down took the whole block down with it.
  // The reason a *previous* run gave for not writing one is still on the row —
  // a file that outgrew the limit keeps it beside the abstract it had — and
  // showing that in place of what was hidden answers a question nobody asked.
  if (meta.hidden) return null

  if (!summary) {
    // The reason explains a feature, so it is worth nothing on a site that
    // does not have the feature — and the reasons outlive the setting, because
    // they are on the row: a deployment that tried abstracts and then cleared
    // AI_SUMMARY_MODEL keeps every one it recorded, 44 of them in the first
    // catalogue this ran against.
    //
    // Asked here rather than taken off in the projection because the switch is
    // the named model (ADR-053 §6.1), which is environment and invisible to
    // SQL; reaching the projection with it would mean a constructor argument
    // through two services and fifty call sites. Only an explicit yes shows
    // the notice, so it arrives late rather than appearing where it does not
    // belong — and the abstract itself never waits on this.
    if (resourceSummaryEnabled !== true) return null
    // A draft's abstract is absent for a reason that is not the reader's.
    const reason = meta.skipReason
    if (!reason || reason === 'hidden' || reason === 'not-public') return null
    return (
      <p className="text-sm text-muted-foreground" role="note">
        {t(`skipped.${reason}`)}
      </p>
    )
  }

  if (meta.source === 'human') {
    return <p className="text-sm whitespace-pre-line">{summary}</p>
  }

  return (
    <section aria-labelledby="resource-abstract-heading" className="flex flex-col gap-2">
      {/* Named before it is read, not explained after. A reader who skims the
          page has to be able to tell at a glance that these sentences were
          written by a machine — a footnote under the text is found only by
          someone who already suspected it. */}
      <h2 id="resource-abstract-heading" className="flex items-center gap-2">
        {/* The AI hue, the same one a search card marks a matched abstract
            with (ADR-053). Tinted rather than filled: the heading names what
            these sentences are, it does not claim the emphasis a primary badge
            would. */}
        <Badge className="gap-1.5 border-ai/20 bg-ai/10 text-ai-tint-foreground">
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
          {t('heading')}
        </Badge>
      </h2>
      <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
        <p className="text-sm whitespace-pre-line">{summary}</p>
        <p className="text-xs text-muted-foreground">
          {t(readKey(meta), { read: meta.coverage?.read ?? 0, total: meta.coverage?.total ?? 0 })}{' '}
          {t('generated', {
            version: meta.version ?? 0,
            date: meta.generatedAt ? formatDate(meta.generatedAt, locale, timeZone) : '',
          })}
        </p>
        {/* Said rather than left to be worked out. The version alone only
            answers "is this current?" for a reader who finds the history,
            reads the number there and compares the two — and the state worth
            catching is exactly the one nobody goes looking for (ADR-053 §7). */}
        {meta.version && latestVersion && meta.version < latestVersion && (
          <p role="note" className="text-xs text-muted-foreground">
            {t('outdated', { latest: latestVersion })}
          </p>
        )}
      </div>
      {/* Placed after the notice, and deliberately not doing the notice's job.
          What protects a reader is the line above — what this was made from,
          and which version — and what protects the catalogue is what the model
          is allowed to say (ADR-053 §7). This says the one thing neither
          covers: the file, not this paragraph, is the record. */}
      <p className="text-xs text-muted-foreground">{t('disclaimer')}</p>
    </section>
  )
}
