import { fireEvent } from '@testing-library/react'

/**
 * Fires a file drop with the dataTransfer shape the drop handlers expect
 * (forgetting `types: ['Files']` silently no-ops them). Returns false when
 * the default action was prevented, as fireEvent does.
 */
export function dropFiles(target: Element, files: File[]) {
  return fireEvent.drop(target, { dataTransfer: { files, types: ['Files'] } })
}
