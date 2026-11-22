'use client'

import { createContext, useContext } from 'react'
import type { PackageState, PipelineStatus } from '@kukan/shared'

/** What the editor's left list needs of a dataset (ADR-072 decision 2) */
export interface EditorPackage {
  id: string
  name: string
  title?: string | null
  state?: PackageState
  private?: boolean
  ownerOrg?: string | null
  creatorUserId?: string | null
  resources: EditorResource[]
}

export interface EditorResource {
  id: string
  name?: string | null
  format?: string | null
  section?: string | null
  pipelineStatus?: PipelineStatus | null
  /** Moves when a run stores a version — what the resource page's panels reload on */
  latestVersion?: number | null
  /** A version whose reading waits on a person (ii-c §8.4): the list's dot */
  typeReviewDue?: boolean
}

interface DatasetEditorContextValue {
  pkg: EditorPackage | null
  /**
   * Take a place in line before reading the dataset, to hand to `publish` with
   * the answer. Ordered by when each read was asked for: an answer that took
   * longer must not overwrite a newer one the list already holds.
   */
  mark: () => number
  /**
   * Hand the list a fresher copy of the dataset. The dataset page loads the
   * full package anyway and refetches it as runs settle, so it passes what it
   * holds instead of the list asking the server again.
   */
  publish: (pkg: EditorPackage, at: number) => void
  /** Ask the list to read the dataset again, after a write elsewhere on the page */
  reload: () => Promise<boolean> | void
  /** Whether the viewer may write the dataset (`canEditPackage`); false until known */
  canEdit: boolean
  /**
   * Nothing on the screens is to be written: a deleted dataset (ADR-072
   * decision 4), or one the viewer only reads
   */
  readOnly: boolean
  /** The viewer's memberships, as `/users/me/organizations` reports them; null until known */
  organizations: { id: string; name: string; title?: string | null; role?: string }[] | null
  /**
   * The dataset page reads its own full copy of the package. While it is open
   * the list asks it, rather than the server twice, when the data has to be
   * read back (a run settled, an upload finished); it publishes what it read.
   */
  setPageReloader: (reload: (() => Promise<boolean>) | null) => void
  /** Whether the list has uploads or pipeline-starting writes in flight (ADR-040's gate) */
  uploading: boolean
  /**
   * The open page holds edits not yet saved. The editor asks before leaving
   * them (ADR-072 decision 5) — one guard for the page and the list's staged
   * order, so a link is asked about once.
   */
  setPageUnsaved: (unsaved: boolean) => void
  /** The dataset could not be read: nothing under it is to be shown as its */
  missing?: boolean
  /**
   * The resource page's open tab, kept here so moving to another resource of
   * the dataset opens it on the same one. Absent outside the editor.
   */
  resourceTab?: string
  setResourceTab?: (tab: string) => void
}

const DatasetEditorContext = createContext<DatasetEditorContextValue | null>(null)

export const DatasetEditorProvider = DatasetEditorContext.Provider

/**
 * The dataset editor around this page, or null outside one — the pages under
 * it are also rendered on their own in tests.
 */
export function useDatasetEditor(): DatasetEditorContextValue | null {
  return useContext(DatasetEditorContext)
}
