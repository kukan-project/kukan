import type { Metadata } from 'next'

export interface BrandPage {
  default: React.ComponentType
  metadata?: Metadata
}

/** フォーク側でページを追加する場合はここに登録 */
export const pages: Record<string, () => Promise<BrandPage>> = {
  terms: () => import('./terms'),
}
