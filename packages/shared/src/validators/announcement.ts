/**
 * KUKAN Announcement Validators
 */

import { z } from 'zod'

export const announcementCategories = ['info', 'maintenance', 'release', 'important'] as const
export type AnnouncementCategory = (typeof announcementCategories)[number]

export const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(500),
  category: z.enum(announcementCategories).default('info'),
  link: z
    .union([
      z.url().refine((url) => /^https?:\/\//i.test(url), 'Only http and https URLs are allowed'),
      z.literal(''),
    ])
    .nullish(),
  publishedAt: z.coerce.date().nullish(),
})

export const updateAnnouncementSchema = createAnnouncementSchema

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>
