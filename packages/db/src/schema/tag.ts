/**
 * KUKAN Tag Schema
 * vocabulary, tag, and package_tag tables
 */

import { pgTable, uuid, varchar, unique } from 'drizzle-orm/pg-core'
import { packageTable } from './package'

export const vocabulary = pgTable('vocabulary', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).unique().notNull(),
})

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    vocabularyId: uuid('vocabulary_id').references(() => vocabulary.id),
  },
  (table) => [unique('uq_tag_name_vocabulary').on(table.name, table.vocabularyId)]
)

export const packageTag = pgTable(
  'package_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packageTable.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (table) => [unique('uq_package_tag').on(table.packageId, table.tagId)]
)
