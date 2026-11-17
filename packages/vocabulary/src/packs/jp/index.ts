/**
 * The Japan pack: the Standard Area Code for Statistics, which holds the local
 * government codes (JIS X 0402) and the groups of areas statistics tables put
 * among them, with the changes to the local governments since 2005
 * (ADR-073 §決定 9). `codes.json` is made by `scripts/build-jp-pack.ts`; see
 * there for its sources and to refresh it.
 */

import { packVersion } from '../../fingerprint'
import type { CodeEntry, Pack, SchemeDefinition, Source } from '../../types'
import data from './codes.json' with { type: 'json' }

const schemes: SchemeDefinition[] = [
  {
    id: 'jp-area-code',
    concept: 'admin-area',
    label: {
      ja: '統計に用いる標準地域コード（全国地方公共団体コードを含む）',
      en: 'Standard area code for statistics (Japan; includes the local government code)',
    },
    sources: data.sources as Source[],
    checkDigit: 'mod11-weights-6-2',
    codeFolding: ['nfkc'],
    nameFolding: ['nfkc', 'strip-spaces', 'small-kana-ke', 'variant-chars'],
    // Characters names are also written with, as the code table writes them.
    // A pair is added only where folding it joins no two places' names
    variantChars: { 梼: '檮', 桧: '檜', 鯵: '鰺' },
    representations: [
      { id: 'code6', kind: 'code', pattern: '\\d{6}' },
      {
        id: 'code5',
        kind: 'code',
        pattern: '\\d{5}',
        toCanonical: 'append-check-digit',
        headings: ['団体コード', '市区町村コード', '市町村コード', '自治体コード'],
      },
      // A prefecture by the two digits its code starts with: `13` is 130001
      {
        id: 'pref2',
        kind: 'code',
        pattern: '\\d{2}',
        padEnd: 5,
        toCanonical: 'append-check-digit',
        headings: ['都道府県コード', '県コード', '都道府県番号'],
      },
      {
        id: 'name',
        kind: 'name',
        lang: 'ja',
        qualified: { separator: '', order: 'parent-first' },
      },
    ],
    codeHeadings: ['コード', '番号', 'code'],
    // The totals and catch-alls statistics tables put among the places
    notAreas: [
      '全国',
      '合計',
      '総計',
      '総数',
      '計',
      '小計',
      'その他',
      '不明',
      '海上',
      '（海上）',
      '県外',
      '国外',
      // A prefecture's statistics group its municipalities
      '区部',
      '市部',
      '郡部',
      '町村部',
      '島部',
      // The ward area under Tokyo's short name, which no group's names are indexed under
      '東京特別区部',
    ],
    // The other groups statistics tables put among the places, by how their
    // names end: a total (県計, 市計), a county, a region (大阪市地域, 北九州市圏域),
    // a prefecture's branch office (大島支庁, 石狩振興局) — those the code table
    // no longer holds, its groups being no area already. No municipality's name
    // ends so
    notAreaPatterns: ['.*計', '.+郡', '.+地域', '.+圏域', '.+支庁', '.+振興局'],
    codes: data.codes as CodeEntry[],
  },
]

export const JP_PACK: Pack = {
  id: 'JP',
  version: packVersion(data.version, schemes),
  schemes,
  // The change list says what replaced what in prose; read into ratios it
  // would be guessed, so the correspondences wait for a source that states them
  correspondences: [],
}
