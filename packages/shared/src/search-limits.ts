/**
 * Bounds on a dataset search's input, the same on every path that reaches the
 * index — the REST API, MCP and the CKAN-compatible API — and in the web UI
 * that pages through it.
 */

/**
 * A search's query, at most, in characters: each distinct query is one
 * embedding call. The passage search sets its own (PASSAGE_QUERY_MAX_CHARS)
 */
export const SEARCH_QUERY_MAX_CHARS = 500

/**
 * How deep a search pages, at most: `offset + limit` past this is refused.
 * OpenSearch's default `index.max_result_window`, which answers a deeper page
 * with an error rather than results.
 */
export const SEARCH_RESULT_WINDOW = 10_000
