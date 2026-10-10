/**
 * Example-query chips under the search box (ADR-036): the limits the admin
 * screen enforces as it is edited and the API checks on save.
 */

import { z } from 'zod'

export const SEARCH_EXAMPLE_QUERIES_MAX_ENTRIES = 10
export const SEARCH_EXAMPLE_QUERY_MAX_LENGTH = 100

export const searchExampleQueriesSchema = z
  .array(z.string().trim().min(1).max(SEARCH_EXAMPLE_QUERY_MAX_LENGTH))
  .max(SEARCH_EXAMPLE_QUERIES_MAX_ENTRIES)
