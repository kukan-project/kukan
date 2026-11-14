/**
 * The Japan pack: the local government codes (JIS X 0402) the Ministry of
 * Internal Affairs and Communications keeps, with the changes since 2005.
 * `codes.json` is made by `scripts/build-jp-pack.ts`; see there to refresh it.
 */

import { packVersion } from '../../fingerprint'
import type { CodeEntry, Pack, SchemeDefinition } from '../../types'
import data from './codes.json' with { type: 'json' }

const schemes: SchemeDefinition[] = [
  {
    id: 'jp-lg-code',
    concept: 'admin-area',
    label: { ja: '全国地方公共団体コード', en: 'Local government code (Japan)' },
    publisher: '総務省',
    license: {
      name: '公共データ利用規約（第1.0版）',
      url: 'https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html',
      derivatives: true,
    },
    source: { url: 'https://www.soumu.go.jp/denshijiti/code.html', retrieved: data.retrieved },
    checkDigit: 'mod11-weights-6-2',
    codeFolding: ['nfkc'],
    nameFolding: ['nfkc', 'strip-spaces', 'small-kana-ke'],
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
      { id: 'name', kind: 'name', qualified: { separator: '', order: 'parent-first' } },
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
    ],
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
