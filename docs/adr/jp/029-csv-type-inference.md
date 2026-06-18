# ADR-029: CSV/TSV プレビュー Parquet の列型自動推定

## ステータス

**承認済み（Accepted）**

ADR-016「DuckDB-WASM データエクスプローラー」のフェーズ 2、および ADR-014「プレビュー Parquet 形式」の
「列型: 全列 STRING」を拡張する設計。整数・小数・真偽値の推定を Extract ステップに実装済み。

## コンテキスト

現状、Extract ステップ（`apps/worker/src/pipeline/steps/extract.ts`）は CSV/TSV の全列を
`type: 'STRING'`（物理 `BYTE_ARRAY` ＋ 論理 `UTF8`）で Parquet に書き込んでいる。
このため以下の制約がある（ADR-016 コンテキスト参照）:

1. **数値ソートが不正**: DuckDB エクスプローラーで `"9" > "80"` となる（辞書順比較）
2. **Row Group 統計が無意味**: 全列 STRING のため min/max 統計による Row Group スキップが効かない
3. **項目一覧の型表示が無価値**: 項目一覧（ADR 未採番、`ResourceFields`）の「型」が常に「文字列」
4. **範囲フィルター不可**: `BETWEEN` 等の数値範囲フィルター（ADR-016 フェーズ 3）の前提が欠ける

CSV/TSV はパイプラインで既に全行パース済みであり、列ごとに値を走査して型を推定し、
型付き Parquet を書き込むコストは小さい。

## 検討した選択肢

### A) 全列 STRING のまま（現状維持）

- 良い点: 最も単純。誤判定リスクゼロ
- 問題点: 上記の制約がすべて残る

### B) 列型の自動推定 — 採用

- 良い点: 数値ソート・統計・型表示・範囲フィルターの基盤が整う
- 問題点: 推定誤りのリスク（例: 郵便番号や路線コードを整数化し先頭ゼロが消失）

### C) ユーザーによる手動型指定（スキーマ編集 UI）

- 良い点: 誤判定なし
- 問題点: 実装コストが大きく、編集の手間。自動推定とは排他でなく将来の上乗せ機能

## 決定

**Extract ステップで CSV/TSV の各列の型を保守的に自動推定し、型付き Parquet を書き込む。**

推定誤りはオープンデータにおいて致命的になりうるため、**全行が確実に適合する場合のみ型付け**し、
少しでも曖昧なら STRING にフォールバックする保守的な方針を採る。元の生ファイルは常に保持される
（ADR-014）ため、推定はベストエフォートで許容される。

### 1. 対象とする型

| 推定型 | Parquet 型（物理 / 論理）     | 値の表現（hyparquet-writer） |
| ------ | ----------------------------- | ---------------------------- |
| 整数   | `INT64`                       | `bigint`                     |
| 小数   | `DOUBLE`                      | `number`                     |
| 真偽値 | `BOOLEAN`                     | `boolean`                    |
| 文字列 | `BYTE_ARRAY` / `UTF8`（現状） | `string`                     |

- **日付・日時は対象外**（当面 STRING 据え置き）。日付形式の曖昧性（`YYYY/MM/DD` と `MM/DD/YYYY`、
  和暦、区切り文字、時刻の有無）による誤判定リスクが高いため。将来別 ADR で TIMESTAMP 化を検討する。

### 2. 推定アルゴリズム（列ごと・全行スキャン）

1. 列の全セルを走査し、**空セル（`=== ''`）を除いた非空値の集合**を対象とする。
2. 非空値が 0 件（全行空）の列は **STRING**（推定不能）。
3. 非空値が **すべて** 次のパターンに適合する最初の型を採用する（精度順）:
   - **真偽値**: すべてが `true` / `false`（大文字小文字無視）のみ。
     `0`/`1`・`はい`/`いいえ`・`yes`/`no` は**含めない**（整数や言語差との衝突を避けるため厳格に）。
   - **整数 (INT64)**: すべてが `/^-?\d+$/` に適合し、かつ次の保守ガードをすべて満たす:
     - 先頭ゼロを持たない（`"0"` 単体は可、`"01234"` は不可 → コードとみなし STRING）
     - 符号付き 64bit 整数の範囲内（`|v| ≤ 2^63 − 1`）。超過は STRING（桁を保持）
   - **小数 (DOUBLE)**: すべてが `/^-?\d+\.\d+$/` に適合（整数部・小数部を必須とする）。
     - 整数部の先頭ゼロ（`"01.5"`）は不可 → STRING。指数表記（`1e5`）・千区切り（`1,000`）は対象外
   - 上記いずれにも当てはまらない → **STRING**
4. 値に前後の空白を含むセルがある列は、正規表現に適合せず自動的に STRING になる（トリムはしない）。

> 整数は小数の部分集合だが、より狭い型（INT64）を優先する。混合型（数値と文字列の混在等）は STRING。
> なお INT64 範囲外の整数パターン値は（DOUBLE では桁が変わるため）数値とみなさず、小数と混在していても
> 列全体を STRING にフォールバックする（純整数列の桁溢れ → STRING と同じ扱い）。

### 3. null（欠損値）の表現

- **型付き列（整数・小数・真偽値）**: 空セルを実 `null` として書き込む（`repetition_type: OPTIONAL`）。
  これにより Parquet の `null_count` 統計が有効になり、将来「欠損数」表示や統計スキップに活用できる。
- **STRING 列**: 現状どおり空文字列 `''` を維持する（変更範囲を限定）。
- 必須/任意（REQUIRED/OPTIONAL）の意味付け精緻化は本 ADR の対象外（別途）。型付き列は一律 OPTIONAL とする。

### 4. 値の変換（書き込み時）

`columnData[].type` に推定型を指定し、各セルを以下に変換する（空セルは型付き列で `null`）:

| 型     | 変換                                                     |
| ------ | -------------------------------------------------------- |
| 整数   | `cell === '' ? null : BigInt(cell)`                      |
| 小数   | `cell === '' ? null : Number(cell)`                      |
| 真偽値 | `'true'→true` / `'false'→false`（大小無視）、`'' → null` |
| 文字列 | `row[colIndex] ?? ''`（現状のまま）                      |

`hyparquet-writer` は `INT64=bigint` / `DOUBLE=number` / `BOOLEAN=boolean` を要求し、
型不一致は実行時エラーになるため、推定と変換は厳密に対応させる。

### 5. 推定範囲とコスト

- **全行スキャン**（サンプリングしない）。データは既にメモリ上にあり（`MAX_PARQUET_SOURCE_SIZE` = 50MB 以内）、
  末尾の異質値による誤判定を避けることを優先する。
- 計算量は O(行 × 列) の追加 1 パスで、ネットワーク I/O やパース自体に比べ無視できる。

### 6. フロントエンドへの影響

- **項目一覧（`ResourceFields`）**: `mapFieldType()` が論理/物理型から型を判定するため、
  型付き Parquet を出せば「整数」「小数」「真偽値」が**自動で表示される**（フロント変更不要）。
- **hyparquet プレビュー（`ParquetPreview`）**: 型付き列は数値・真偽値として読まれるが、
  セル描画は `String(value)` のため表示は維持される（`bigint`/`number`/`boolean` いずれも文字列化可能）。
- **DuckDB エクスプローラー**: 現状の `CAST(col AS VARCHAR)` 方式のままでも壊れない。ただし
  **数値ソートを正しくするには型付き列で CAST を外す型認識 SQL が必要**（ADR-016 フェーズ 3 で対応）。
  本 ADR の範囲では、型表示と Parquet 統計の整備までを直接の成果とする。

### 7. 後方互換と再生成

- 既存の Parquet プレビューは全列 STRING のまま。新ロジックは**新規アップロードおよび再処理時のみ**適用。
- 一括再生成は行わない。リソースの再処理（`reprocess`）により順次型付きへ更新される。

## 影響

- `apps/worker/src/pipeline/steps/extract.ts` に型推定・値変換ロジックを追加。
  推定関数は単体テスト可能なよう純関数（`inferColumnType(values): FieldType`）として切り出す。
- ADR-014 の「列型: 全列 STRING」は CSV/TSV について本 ADR で拡張（数値・真偽値は型付き）。
- ADR-016 フェーズ 2 を実現。フェーズ 3（範囲フィルター・型認識 SQL）の前提が整う。
- 設定値（許容する真偽値リテラル等）は `apps/worker/src/config.ts` に定数として置く余地がある。
- テスト: 推定純関数のユニットテスト（整数・小数・真偽値・先頭ゼロ・桁溢れ・混合・空列・null 混在）を必須とする。

## 残課題（未解決事項）

本 ADR では扱わず、将来の検討・実装に委ねる項目。

1. **日付・日時の TIMESTAMP 化**: 形式の曖昧性（区切り文字・和暦・時刻有無・`MM/DD` と `DD/MM`）の
   解決方針を定めた上で別 ADR とする。設計メモ（調査済み）:
   - **型**: 日付のみ → `INT32` + 論理型 `DATE`（TZ レスで安全、壁時計問題が起きない）。
     日時 → `INT64` + **naive TIMESTAMP**（`isAdjustedToUTC: false`）。フロントの `mapFieldType()` は
     `DATE` → 日付、`TIMESTAMP_MILLIS/MICROS` → 日時に対応済み（表示側の変更不要）。
   - **TZ なし日時は使える**: `logical_type: { type: 'TIMESTAMP', unit: 'MILLIS', isAdjustedToUTC: false }`。
     DuckDB は `TIMESTAMP`（without time zone）として読む。CSV の TZ 情報なし日時にはこれが適切。
   - **hyparquet-writer の制約**: 値変換（`unconvert`）は `converted_type` で分岐するため、
     `converted_type: 'TIMESTAMP_MILLIS'` を併記しないと `Date → bigint` 変換が走らない。
     よって `converted_type: 'TIMESTAMP_MILLIS'` ＋ `logical_type(isAdjustedToUTC: false)` を併用する
     （日付は `INT32` + `converted_type: 'DATE'`）。
   - **スキーマ指定方式**: `parquetWriteBuffer` は `schemaOverrides` を直接受けない。
     `schemaFromColumnData({ columnData, schemaOverrides })` で完全スキーマを生成して `schema` として渡す。
     このとき `columnData` から `type` を外す（`schema` と `columnData[].type` の併用は throw）。
   - **エンコードの落とし穴**: `unconvert` は `Date.getTime()`（UTC エポックミリ秒）を使うため、
     ローカル TZ で生成した `Date` を渡すとサーバ TZ 分ずれる。**壁時計成分を UTC 基準のミリ秒に変換**して
     （`Date.UTC(...)` で作るか、事前計算した数値/bigint を直接）渡し、サーバ TZ の影響を排除すること。
2. **DuckDB エクスプローラーの型認識 SQL**: 型付き列で `CAST(... AS VARCHAR)` を外し、数値ソート・
   範囲フィルター（`BETWEEN`）を正しく機能させる（ADR-016 フェーズ 3）。本 ADR 単体では数値ソートは
   辞書順のまま。
3. **REQUIRED/OPTIONAL（必須/任意）の精緻化**: 型付き列を一律 OPTIONAL としているため、項目一覧の
   「Null 許容」が常に「可」になる。空セルの有無から REQUIRED を判定して意味を持たせる。
4. **STRING 列の実 null 化と `null_count` 統計**: STRING 列は空文字列のままのため欠損数を出せない。
   全列実 null 化の影響（プレビュー・検索）を確認した上で検討。
5. **既存 Parquet の一括バックフィル**: 既存プレビューは再処理されるまで全列 STRING のまま。
   一括再生成バッチの要否を判断する。
6. **項目一覧の統計表示**: `null_count`・min/max 等を項目一覧に表示する（writer の統計出力前提）。
7. **真偽値リテラルの拡張**: 現状は `true`/`false` のみ。`0`/`1`・`yes`/`no`・`はい`/`いいえ` 等を
   設定で許容するか。
8. **小数パターンの拡張と DECIMAL 厳密化**: 指数表記（`1e5`）・千区切り（`1,000`）・整数のみの DOUBLE 列の扱い。
   - **DOUBLE の精度**: 緯度経度（必要桁 9〜11 桁）は double の有効桁（約 15〜16 桁）で十分に正確で、
     表示も `Number.toString()` の最短往復表現により元どおり（例: `0.1` は `0.1` と表示）。誤差が顕在化するのは
     DuckDB の集計（SUM/AVG 等）など演算時のみ。よって座標は DOUBLE で問題なく、当面 DOUBLE を維持する。
   - **「往復ガード」案は不採用**: 「`String(Number(v)) === v` でない小数列は STRING に落とす」案は、
     末尾ゼロ付き座標（`35.680000` → `35.68`）を軒並み STRING 化してソート・統計を失わせるため採らない。
   - **厳密 10 進が要件化した場合は DECIMAL**: Parquet の `DECIMAL(precision, scale)`（物理 INT32/INT64/
     FIXED_LEN_BYTE_ARRAY のスケール済み整数）を列ごとに採用する。設計:
     - 列を全行走査し、`scale` = 小数桁数の最大値（**テキスト**から数える。`Number` 化すると末尾ゼロが失われるため）、
       `precision` = 整数部最大桁数 + `scale`。
     - 物理型は precision で選択（≤9 INT32 / ≤18 INT64 / >18 FIXED_LEN_BYTE_ARRAY）。`schemaOverrides` で
       `{ type, converted_type: 'DECIMAL', scale, precision }` を指定（基本型 `type` に DECIMAL が無いため）。
     - **hyparquet 固有の制約**: writer の DECIMAL 書き込みは JS `number` 経由（`Math.round(v × 10^scale)`）。
       スケール済み整数が `Number.MAX_SAFE_INTEGER`（2⁵³）に収まる範囲（**おおむね precision ≲ 15**）でのみ厳密。
       超過する列は hyparquet では厳密に書けないため STRING フォールバックとする。
     - 金額（2 桁）・座標（6〜8 桁）等の実データは precision 15 未満が大半で、この範囲なら DECIMAL は厳密
       （オンディスクは正確な 10 進、DuckDB もネイティブ DECIMAL として厳密に読む）。
9. **手動型指定（スキーマ編集 UI）**: 自動推定の誤りをユーザーが上書きできる仕組み（選択肢 C、将来の上乗せ）。

## 関連 ADR

- ADR-014: プレビュー Parquet 形式（本 ADR が「列型」を拡張）
- ADR-016: DuckDB-WASM データエクスプローラー（本 ADR がフェーズ 2 を具体化）
- ADR-021: リソースコンテンツ全文検索（Index ステップは本変更の影響を受けない）
