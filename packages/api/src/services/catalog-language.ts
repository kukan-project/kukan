/**
 * The language a catalog is written in, told from its public datasets' titles
 * (what the MCP server's instructions name, so a model searches in it).
 */

import { and, desc, eq } from 'drizzle-orm'
import { packageTable, type Database } from '@kukan/db'

/** A language a catalog's titles can be told to be in by their script alone. */
export type CatalogLanguage = 'Japanese' | 'Korean'

/** Titles the language is told from: the datasets last updated, public ones only. */
const SAMPLE = 50

const share = (titles: string[], script: RegExp) =>
  titles.filter((t) => script.test(t)).length / titles.length

/**
 * The language of a catalog, told from its titles' scripts. Japanese needs kana
 * in some of them: kanji alone (a report's name, 人口統計) is written the same in
 * Chinese, so a catalog of kanji alone is left unnamed rather than guessed —
 * told to search in the wrong one, a model finds nothing. So are letters alone,
 * which cannot tell English from French, and a catalog too mixed to say.
 */
export function languageOfTitles(titles: string[]): CatalogLanguage | null {
  if (titles.length === 0) return null
  if (share(titles, /[\uac00-\ud7af]/) >= 0.5) return 'Korean'
  if (
    share(titles, /[\u3040-\u30ff]/) >= 0.2 &&
    share(titles, /[\u3040-\u30ff\u4e00-\u9fff]/) >= 0.5
  )
    return 'Japanese'
  return null
}

/** The language the catalog's public datasets are written in, where it can be told. */
export async function catalogLanguage(db: Database): Promise<CatalogLanguage | null> {
  const rows = await db
    .select({ title: packageTable.title, name: packageTable.name })
    .from(packageTable)
    .where(and(eq(packageTable.state, 'active'), eq(packageTable.private, false)))
    .orderBy(desc(packageTable.updated))
    .limit(SAMPLE)
  return languageOfTitles(rows.map((r) => r.title || r.name))
}
