import type { Metadata } from 'next'

export interface BrandPage {
  default: React.ComponentType
  metadata?: Metadata
}

/** Forks register additional pages here */
export const pages: Record<string, () => Promise<BrandPage>> = {
  terms: () => import('./terms'),
}
