/**
 * What the MCP server tells a client about using it as a whole (the
 * `instructions` of the initialize result, which clients put before the
 * model). The tools' own descriptions say what each returns; this says how
 * they go together, and what a model measured using them got wrong without it:
 * searching in the user's language rather than the catalog's, and with more
 * words than a dataset holds.
 */

import type { CatalogLanguage } from '../services/catalog-language'

export function mcpInstructions(language: CatalogLanguage | null): string {
  return [
    'This server searches and reads an open data catalog: datasets of documents (PDF, Word, PowerPoint, Excel, Ichitaro) and tables (CSV).',
    language
      ? `The catalog's titles, descriptions and documents are in ${language}. Search in ${language}, whatever the language of the question, and answer in the user's language.`
      : "Search in the language the catalog's titles and documents are written in — the language of the titles the searches return — whatever the language of the question, and answer in the user's language.",
    "Search with a few words: the nouns a dataset title or a document would use, not the whole question. When nothing fits, drop a word or try another — a dataset's title names the survey or the record, seldom every figure in it.",
    "Where the answer is in documents' text, search_passages finds the passages; pass a passage's cursor to get_document_section to read around it. Where it is a figure in a table, find the dataset with search_datasets, then use get_resource_schema and query_resource.",
    'Cite the resource, the page or rows, and the URL that each tool gives. The server returns text and where it is from; judging what it means is left to you.',
  ].join('\n')
}
