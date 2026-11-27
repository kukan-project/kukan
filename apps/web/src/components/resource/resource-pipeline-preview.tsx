'use client'

import { useState, useCallback, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Settings2 } from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@kukan/ui'
import { useTranslations } from 'next-intl'
import {
  mayHoldTable,
  showsAsTable,
  type OdataKey,
  type OdataRenamedColumn,
  type OfficePreviewViewer,
  type ResourceSchema,
} from '@kukan/shared'
import { PipelineStatusDetail } from './pipeline-status-detail'
import { ResourcePreview, usePreviewView } from '@/components/preview/resource-preview'
import { ResourceFields, type ColumnRoleView } from './resource-fields'
import { DataApiDialog } from './data-api-dialog'
import { OdataDialog, type ReportedRefusal } from './odata-dialog'
import { useFormattedDateTime } from '@/components/date-time'
import { useFetch } from '@/hooks/use-fetch'
import type { PipelineStatusData } from '@/hooks/use-pipeline-status'

interface ResourcePipelinePreviewProps {
  resourceId: string
  format?: string | null
  url?: string | null
  size?: number | null
  canManage?: boolean
  notPublic?: boolean
  officePreviewViewer?: OfficePreviewViewer
  latestVersion?: number | null
  /** Whether the live version was read as a table, as the server reported it with the page */
  hasTable?: boolean
  /** Open on the table wherever there is one (the dashboard's table settings) */
  opensOnTable?: boolean
  /**
   * The key to mark in place of the stored one: the dashboard's Table settings
   * marks the key being picked, before it is applied.
   */
  primaryKey?: string[] | null
  /**
   * What goes under the table view, in place of the field list: the Table
   * settings tab has its own table of the fields. Shown with the table view only,
   * and kept mounted while another view is.
   */
  belowTable?: ReactNode
}

/**
 * Preview section with optional pipeline management dialog.
 * The dialog shows pipeline status and reprocess button.
 * When pipeline completes, the preview re-mounts and page data refreshes.
 */
export function ResourcePipelinePreview({
  resourceId,
  format,
  url,
  size,
  canManage,
  notPublic,
  officePreviewViewer,
  latestVersion,
  hasTable,
  opensOnTable,
  primaryKey: keyShown,
  belowTable,
}: ResourcePipelinePreviewProps) {
  const t = useTranslations('resource')
  const router = useRouter()
  const [previewKey, setPreviewKey] = useState(0)
  const [open, setOpen] = useState(false)

  // previewKey in path triggers re-fetch after reprocess
  const { data: pipelineData } = useFetch<PipelineStatusData>(
    `/api/v1/resources/${encodeURIComponent(resourceId)}/pipeline-status?_k=${previewKey}`
  )

  // One read for everything on this page that describes the table: the
  // dropped-rows note, the key marking in both preview modes, and the fields
  // list. Only formats an interpretation may make a table from have any of
  // that to say; whether this one did is the schema's answer.
  const { data: schemaData } = useFetch<{
    queryable: boolean
    odataRefusal: ReportedRefusal | null
    odataWideRows: boolean
    odataKey: OdataKey | null
    odataRenamed: OdataRenamedColumn[]
    schema: ResourceSchema | null
    columnRoles: ColumnRoleView[] | null
    primaryKey: string[] | null
  }>(
    mayHoldTable(format)
      ? `/api/v1/resources/${encodeURIComponent(resourceId)}/schema?_k=${previewKey}`
      : null
  )
  const fields = showsAsTable(format, null, schemaData?.schema)

  // Kept here, beside what goes with the table view: the field list describes
  // the table, not the original or the text
  const opening = {
    resourceId,
    format,
    version: latestVersion,
    schema: schemaData?.schema,
    hasTable,
    opensOnTable,
    notPublic,
    officePreviewViewer,
  }
  const [view, setView] = usePreviewView(opening)
  const columns = schemaData?.schema?.columns.length ?? 0
  const tableSize = columns > 0 ? { columns, rows: schemaData?.schema?.rowCount ?? 0 } : undefined

  const handleSettled = useCallback(() => {
    setPreviewKey((k) => k + 1)
    router.refresh()
  }, [router])

  const generatedAt = useFormattedDateTime(
    pipelineData?.pipeline_status === 'complete' ? pipelineData.updated : null
  )

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h4 className="text-xl font-semibold">{t('preview')}</h4>
          {generatedAt && (
            <span className="text-xs text-muted-foreground">
              {t('previewGeneratedAt', { date: generatedAt })}
            </span>
          )}
          {/* That the file was read as a table, whichever view is shown: for a
              workbook or a JSON it is not what the format says (ADR-057 decision 9) */}
          {tableSize && (
            <Badge variant="secondary" className="font-normal">
              {t('previewTableSize', tableSize)}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {schemaData?.queryable && schemaData.schema && (
            <>
              <DataApiDialog resourceId={resourceId} schema={schemaData.schema} />
              <OdataDialog
                resourceId={resourceId}
                odataRefusal={schemaData.odataRefusal}
                odataWideRows={schemaData.odataWideRows}
                odataKey={schemaData.odataKey}
                odataRenamed={schemaData.odataRenamed ?? []}
              />
            </>
          )}
          {canManage && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t('pipelineStatus')}
                  aria-label={t('pipelineStatus')}
                >
                  <Settings2 className="size-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{t('pipelineStatus')}</DialogTitle>
                  <DialogDescription>{t('pipelineStatusDescription')}</DialogDescription>
                </DialogHeader>
                {/* `url` is only set for a source to fetch, never for an upload */}
                <PipelineStatusDetail
                  resourceId={resourceId}
                  uploaded={!url}
                  onSettled={handleSettled}
                />
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      <ResourcePreview
        key={`${resourceId}-${previewKey}`}
        {...opening}
        url={url}
        size={size}
        view={view}
        onViewChange={setView}
        primaryKey={keyShown !== undefined ? keyShown : schemaData?.primaryKey}
      />
      {belowTable !== undefined && view !== undefined && view !== 'table' && tableSize && (
        // The settings sit under the table view; said here so they are not missed
        <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => setView('table')}>
          {t('previewOpenTableSettings')}
        </Button>
      )}
      {belowTable !== undefined ? (
        <div hidden={view !== 'table'}>{belowTable}</div>
      ) : (
        // Field (column) list shares the preview's remount key so it refreshes
        // in lockstep when the pipeline (re)generates the Parquet preview.
        fields && (
          <div className="mt-6" hidden={view !== 'table'}>
            <ResourceFields
              key={`fields-${resourceId}-${previewKey}`}
              resourceId={resourceId}
              primaryKey={schemaData?.primaryKey}
              schema={schemaData?.schema}
              columnRoles={schemaData?.columnRoles}
            />
          </div>
        )
      )}
    </section>
  )
}
