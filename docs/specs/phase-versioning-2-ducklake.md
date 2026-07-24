# Phase Versioning-ii: DuckLake による行レベル差分（層2）— 実装仕様書（ドラフト）

> **目標**: 表形式リソース（CSV/TSV）を DuckLake テーブルとして ingest し、版間の
> **行レベル差分・タイムトラベル・列スキーマ履歴**を提供する。カタログは既存 PostgreSQL、
> データファイルは既存ストレージ（S3/MinIO）。Phase i の正本バージョン（層1）から常に
> 再構築可能な派生インデックスとして位置づける。設計判断は ADR-043 を正とする。

## 1. 前提

- **Phase i（層1）完成済み**: `resource_version` テーブル、版ファイル保持（全フォーマット）、
  パージ、バックフィル（`docs/specs/phase-versioning-1-file-retention.md`）
- **既存の型推論（ADR-029）**: `apps/worker/src/pipeline/type-inference.ts` の `inferColumnType()`
  が列を `integer` / `float` / `boolean` / `string` に推論し、Extract が
  `ResourceSchema`（`packages/shared`）として組み立て、Phase i で **版ごとにスナップショット**
  （`resource_version.schema`）している
- **サーバーサイドクエリのサンドボックス（ADR-032）**: Parquet をインメモリ実体化 →
  `enable_external_access=false` + `lock_configuration=true` の隔離モデル。**本フェーズでも無変更**
- **`@duckdb/node-api`** は ADR-032 で導入済み。DuckLake は同ライブラリの拡張として利用する
- **アダプターは増やさない（ADR-005）**: DuckLake はアダプター化せず、専用パッケージに隔離する

## 2. 段階分け（本フェーズは一度に全部を実装しない）

行レベル差分の価値は「キーなしの追加/削除サマリ + スキーマ変化検知」だけで大半が得られる。
主キー MERGE・型降格 UX は上に積む拡張とし、以下の順で段階導入する。

| 段階            | 内容                                                                                       |   主キー    | 型降格 UX  |
| --------------- | ------------------------------------------------------------------------------------------ | :---------: | :--------: |
| **ii-a（MVP）** | DuckLake ingest + キーなし差分（追加/削除行・行数）+ スキーマ変化検知 + 差分 API（管理者） |      –      |     –      |
| **ii-b**        | 主キー指定（リソース設定・手動）→ `MERGE` による**変更行**追跡。列スキーマ履歴             |  手動指定   |  記録のみ  |
| **ii-c**        | 型降格の選択肢提示 UX、AI による主キー候補・型提案（ADR-040 拡張）                         | AI 候補提示 | 選択肢提示 |

**ii-a を最小の縦切りとして先に通す**（実データで ingest→差分が成立することを確認する）。
以降は需要とスパイク結果を見て積む。

## 3. アーキテクチャ概要

```
層2（本仕様書）: DuckLake（表形式リソースのみ、CSV/TSV・≤50MB から）
  カタログ    既存 PostgreSQL 内の専用スキーマ（例: ducklake）  ← DuckLake 拡張が管理、Drizzle 対象外
  データ      既存バケットの専用 prefix（例: lake/）             ← Parquet 実体、不変・追記のみ
  テーブル    res_{resourceId のハイフン除去}                    ← resource.id から機械導出
  版対応      resource_version.ducklake_snapshot_id             ← 「リソースの版 ↔ DuckLake スナップショット」

  === ingest（Worker、Phase i の Version 捕捉の後段）===
  Fetch → Extract（型推論, ADR-029）→ Version（層1捕捉, Phase i）→ Lake（層2 ingest, 新設）→ Index
    Lake ステップ: 表形式リソースの新版を DuckLake テーブルにコミットし、
                   得たスナップショット ID を resource_version に記録

  === 差分参照（API、新設）===
  GET /resources/:id/versions/:v/diff?from=      ← サーバー組み立ての固定クエリのみ（DuckLake アクセスあり）

  === クエリ（既存, ADR-032）===
  POST /resources/:id/query                       ← ユーザー/AI の生 SQL。DuckLake に触れない（無変更）
```

**DuckLake は層1から再構築可能な派生インデックス**（ADR-043）。カタログ・データが壊れても
全リソースの再 ingest で復元できる。正本は層1の版ファイル。

## 4. Step 1 — DuckLake 統合基盤（`@kukan/lake` パッケージ）

DuckLake に触れるコードを 1 パッケージに隔離する（ADR-005 の思想。api=読み取り / worker=書き込み
以外から DuckLake に触れさせない）。

1. **接続**（DuckDB セッションで ATTACH）:

   ```sql
   ATTACH 'ducklake:postgres:host=<pg> dbname=<db>' AS lake (
     DATA_PATH 's3://<bucket>/lake/',
     METADATA_SCHEMA 'ducklake'
   );
   ```

   - カタログは意味層と同一 PostgreSQL に同居（差分・版対応と JOIN 可能な一枚岩）。
     DuckLake カタログ表は **Drizzle のマイグレーション対象外**
   - ストレージ接続: S3StorageAdapter と同じ資格情報・エンドポイントを DuckDB の httpfs 設定
     （`SET s3_endpoint`/`s3_access_key_id`/… または secret）に流し込む。**dev の MinIO は
     `s3_url_style='path'` + endpoint 指定**が要る（要スパイク検証）

2. **テーブル命名**: `res_{resourceId のハイフン除去}`。`resource.id` から機械導出でき逆引きも一意。
   人間可読名は DuckLake に持ち込まない（リソース改名を物理層に波及させない）
3. **書き込みは worker 専任・リソース単位で直列化**: `pg_advisory_xact_lock(hashtext(resourceId))`
   で直列化し、「ロック取得 → DuckLake トランザクション → 意味層更新（`resource_version`）→ コミット」
   を 1 ジョブハンドラで行う。**1 版更新 = 1 DuckLake トランザクション**（複数テーブルをまたぐ
   コミットはしない → 版とスナップショットの対応を単純に保つ）
4. **障害時の整合**: DuckLake コミット済み・意味層未更新の瞬間に落ちたら、意味層に対応行のない
   スナップショットは「未確定」。起動時リコンシリエーションで検出し、監査ログに記録して放置
   （未参照スナップショットは無害、後述の expire で自然回収）または expire する

## 5. Step 2 — Lake ingest ステップ（Worker）

`apps/worker/src/pipeline/steps/lake.ts` を新設し、`processResource` の **Version ステップの後**に
挿入する（層1の版が確定してから層2へ）。

- **対象**: 表形式（CSV/TSV・≤50MB、現行の Parquet 生成対象と同一）。それ以外はスキップ。
- **入力**: Version ステップが今回新しい版（vN）を捕捉した場合のみ動く。Extract の型推論結果
  （`ResourceSchema`）を列型として使う。
- **ingest ロジック**（段階で深くする）:
  - **ii-a**: 版ごとに **テーブルへ全行を投入**（キーなし＝全差し替え）。DuckLake の
    コピーオンライトで変わらないファイルは版間共有され、書き込みは差分コスト。
  - **ii-b**: 主キー指定ありなら `MERGE`（後述 §7）で行単位に反映。
- **スナップショット記録**: コミットで得た `snapshot_id` を `resource_version.ducklake_snapshot_id`
  に書く。以後「版 vN の読み取り」= `SELECT ... FROM lake.res_x AT (VERSION => snapshot_id)`。
- **非クリティカル**: Lake ステップの失敗はステップに記録するがパイプライン全体は継続する
  （層1の版・プレビュー・検索は動く）。層2は後から再 ingest で追随できる。

### 5.1 DB スキーマ追加（`resource_version`）

Phase i の `resource_version` に列を追加する（Drizzle マイグレーション）:

- `ducklake_snapshot_id BIGINT`（表形式版のみ非 null。層2の版の指し先）
- （ii-b）主キーはリソース設定側に持つ（§6）。版側には不要

## 6. Step 3 — 主キー指定（ii-b）

- **リソース設定に「キー列」を管理者が任意指定**（複数列可）。指定があれば Lake ingest が
  `MERGE` 経路に切り替わる。**v1 は手動指定のみ**。
- 保存先: `resource.extras` の JSONB か、`resource_pipeline.metadata` に `keyColumns: string[]`。
- キー指定の変更は「以後の版から適用」。過去版の差分意味論は変えない。
- **ii-c**: ADR-040 の AI 提案基盤に「主キー候補提示」を追加（列のユニーク率・null 率を
  決定的に算出 → 候補提示、断定しない）。

## 7. Step 4 — 差分抽出（3段フォールバック）と差分 API

ADR-043 §3-6 の 3 段フォールバックを実装する。

1. **キーあり** → `MERGE` による行単位差分。DuckLake の `table_changes(res_x, snap_a, snap_b)`
   で **追加・削除・変更**行を取得。履歴が最小コストで残る。
2. **キーなし** → 全差し替え + 統計サマリ（「N 行中 x 行追加・y 行削除」）。行の対応付けは
   行内容ハッシュの一致のみで判定し、**「変更行数」は数えない**（キーなしで変更と追加+削除は
   区別できない。推測で偽の変更履歴を作らない）。
3. **スキーマ変更**（列の増減・型変化）→ 行差分を放棄し、**新版 + スキーマ変更の記録**とする。

**差分 API（新設）**: `GET /resources/:id/versions/:v/diff?from=<v'>`（既定 `from` = 直前版）。

- 返却: `{ addedRows, removedRows, changedRows?, schemaDiff, sampleRows }`。`changedRows` は
  キーあり時のみ。
- **SQL はサーバーが組み立てる固定クエリのみ**（パラメータは版番号のみ）。ユーザー/AI の生 SQL は
  DuckLake に触れない（ADR-032 のサンドボックスは無変更、§10）。
- 可視性チェックは ADR-017/032 と同じ経路。第一の消費者は管理者（品質・監査）。公開リソースの
  差分サマリは閲覧者にも提示しうる（Phase iii で UI 設計）。

## 8. Step 5 — 型判定と「型の降格」の選択肢提示（ii-c）

既存の型推論（ADR-029）は各版で `integer`/`float`/`boolean`/`string` を保守的に推論する。
版をまたぐと推論型が変わることがある（例: v1 で全行整数だった列 `amount` に、v2 で `"N/A"` や
桁区切り `"1,234"` が混入 → v2 は `string`）。これは**列の型降格**（integer → string）であり、
DuckLake 上はスキーマ変化 = §7-3 の「差分放棄・新版」に落ちる。

- **ii-a/b**: 型変化は**スキーマ差分として記録するだけ**（自動で降格を受け入れて新版）。
- **ii-c（選択肢提示 UX）**: 差し替え確認時に「列 `amount` の型が integer → string に変わります」を
  提示し、管理者に選ばせる:
  1. **降格を受け入れる**（列を string 化して取り込む。既定・安全）
  2. **該当行をエラーとして扱う**（型を維持し、外れ値行を差分の「不整合」として提示）

  型の**昇格**（string → integer、全行が整数化した）も同様に検知できるが、既存データを壊さない
  よう既定は「変えない」。UX は Phase iii の差し替えフローと統合する。

型の昇格/降格の格子（どの型からどの型へ動けるか）と、その判定を決定的に行う関数は
`packages/shared` に置き、Extract の推論と差分の両方から使う。

## 9. Step 6 — パージの層2波及

Phase i のパージ（sysadmin 限定・墓標方式・ADR-028）に、表形式リソースの層2消去を足す。

1. 対象版の **DuckLake スナップショットを失効候補にする**。
2. **compaction rewrite**: 削除対象データを含むファイルを、その行を除いて書き直す
   （生存版が共有するファイルは expire だけでは消えないため）。
3. **cleanup**: どの版からも参照されなくなった旧ファイルを物理削除。対象版へのタイムトラベルは
   不能になる（それがパージの目的）。
4. `resource_version.ducklake_snapshot_id` を null 化（墓標行は残す）。

物理消滅タイムライン（S3 noncurrent 30 日 + バックアップ保持、ADR-037）は Phase i と同じ。

## 10. サンドボックス分離（ADR-032 は無変更）

| 経路                               | SQL の出所                                                 | DuckLake アクセス                           |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| 差分 API（新設）                   | **サーバー組み立ての固定クエリのみ**（パラメータは版番号） | あり                                        |
| `/query`・`query_resource`（既存） | ユーザー/AI の生 SQL                                       | **なし**（従来どおり実体化 → ロックダウン） |

ユーザー SQL に DuckLake カタログ・データファイルを触らせない。既存クエリ経路の拡張は
「`version` パラメータで当該版の Parquet を実体化する」に留める（サンドボックス設計は変えない）。

## 11. 運用

1. **コンパクション**: 読み取り性能はファイル数に支配される。`ducklake_merge_adjacent_files`
   （カタログ全体 CALL）を worker の高頻度メンテジョブで実行。**版番号は増やさない**
   （タイムトラベルに透過。要スパイク検証）。`latest` はコンパクト済みを保証、履歴版は細切れ許容。
2. **スナップショット expire**（維持管理用の中間スナップショットのみ整理する。業務版は失効させない）:
   - **明示リスト方式**（`versions => [失効候補]`）。失効候補 = 全スナップショット −
     `resource_version` が参照する ID を SQL で算出。**時刻ベース `older_than` は使わない**
     （全テーブル共通連番のため、未更新版の参照先まで巻き込む）。
   - 進行中コミット保護のため「作成から一定時間内のスナップショット」を候補から除外する。
   - `dry_run` → 監査ログ → 実行。
3. **バックアップ整合**（ADR-037）: PG（カタログ+意味層+版対応）が唯一の正。S3 は不変・追記のみ。
   物理削除（cleanup）は **PG バックアップ保持期間より古いスナップショットのみ**を対象にする
   （任意の PG バックアップをリストアしても参照先ファイルが必ず存在する）。リストアは
   PG リストア → リコンシリエーション（§4-4）で、S3 側リストアは不要。

## 12. 影響

- **DB**: `resource_version` に `ducklake_snapshot_id` 追加。DuckLake カタログ用スキーマが
  同一 PostgreSQL に増える（DuckLake 拡張管理、Drizzle 対象外）
- **新パッケージ**: `@kukan/lake`（DuckLake 接続・ingest・差分・メンテ）。worker が書き、api が読む
- **Worker**: パイプラインに Lake ステップ追加、compaction/expire メンテジョブ追加
- **API**: 差分 API 追加。`/query` は無変更（サンドボックス維持）
- **デプロイ**: DuckLake 拡張のロードと httpfs 設定（S3/MinIO）。dev の MinIO は path-style/endpoint
  指定が要る（要検証）
- **既存**: 層1・プレビュー・既存クエリ経路は無変更

## 13. テスト戦略

- **技術検証スパイク（最優先）**: 実データ（CSV）で「ingest → 2 版コミット →
  `table_changes()` で追加/削除が取れる」「MinIO 相手に DATA_PATH が機能する」
  「コンパクションがタイムトラベルに透過」を確認する。ここが成立しなければ ADR-043 の層2方針を
  再訪する。
- **統合テスト**: Lake ingest（版→スナップショット記録）、キーなし差分の統計サマリ、キーあり
  `MERGE` 差分、スキーマ変化検知、expire の明示リスト算出、パージ層2波及。
- **サンドボックス回帰**: 既存 `/query` が DuckLake に到達できないこと（ADR-032 の隔離が無傷）。

## 14. 残課題

1. **クエリ対象拡大**: 現状 ≤50MB CSV/TSV。上限引き上げ・JSON 等（ADR-032/043 と同根）
2. **コンパクション閾値ゲート**: `merge_adjacent_files` はテーブル個別指定不可（カタログ全体）。
   初期は無条件、規模が問題化したら閾値（ファイル数・削除ベクタ比）で発火抑制
3. **マルチサイト（ADR-041）**: カタログをサイト単位で分けるか、単一カタログ + テーブル名 prefix か。
   接続数バジェットへの算入
4. **主キー/型の AI 提案（ii-c）**: ADR-040 拡張。列プロファイル（ユニーク率・null 率・値パターン）を
   決定的に算出 → 候補提示
5. **未承認パッチ/提案フロー**: 「差し替えを提案 → 承認でコミット」型のワークフロー（将来）

## 15. スコープ外（Phase iii）

- 閲覧者向け「前版からの変更」UI、版指定クエリ
- プレビュー Parquet の DuckLake export への統合（生成経路の一本化）
- MCP 差分ツール（`get_resource_diff` 等）
- Iceberg エクスポート（公開スナップショットの外部エンジン直読み）

## 16. 関連 ADR

- ADR-005: アダプターは 4 つのみ（DuckLake は `@kukan/lake` に隔離、アダプター化しない）
- ADR-017: サーバー経由ダウンロード/プレビュー（差分 API の可視性チェック）
- ADR-028: 非同期パージの durable claim（パージ状態遷移）
- ADR-029: 列型推論（型判定・型降格の基盤）
- ADR-032: MCP データクエリ基盤（サンドボックス分離の前提。差分 API は別経路）
- ADR-036: ランタイムシステム設定（保持世代数・メンテ周期）
- ADR-037: バックアップ戦略（層2の expire/cleanup の整合規則）
- ADR-040: AI メタデータ提案（主キー候補・型提案の将来拡張）
- ADR-041: マルチサイトデプロイ（カタログ分割の残課題）
- ADR-043: リソースバージョニングと行レベル差分（本フェーズが実装する層2の設計）
