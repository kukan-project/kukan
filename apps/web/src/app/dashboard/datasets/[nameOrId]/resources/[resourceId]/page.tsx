import { officePreviewViewerSchema } from '@kukan/shared'
import { ResourceEditor } from './resource-editor'

/**
 * A resource's page in the dataset editor (ADR-072). Server-side only to read
 * the site's Office viewer from the environment, as the public page does; the
 * editor itself renders on the client.
 */
export default function ResourceEditorPage() {
  return (
    <ResourceEditor
      officePreviewViewer={officePreviewViewerSchema.parse(process.env.OFFICE_PREVIEW_VIEWER)}
    />
  )
}
