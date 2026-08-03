# Phase 5a: メタデータベクトル検索（セマンティック検索）— 実装仕様書

> **目標**: package メタデータを埋め込みベクトル化し、BM25 とのハイブリッド検索を
> Web 検索 UI・MCP/API の両方で動かす。AI なし環境（NoOp）では BM25 のみへ自動 degrade する。
> 設計判断は ADR-034 を正とする。

## 1. 前提

- Phase 1〜3 完成済み（CRUD + 検索 + パイプライン + Worker + Queue）
- Phase 4（AWS デプロイ & CDK）は進行中だが、本フェーズと実装上の依存はなく**並行実装可**
- ADR-034 合意済み: 環境別分離（AWS=Bedrock / オンプレ=Ollama / NoOp=degrade）、
  ベクトルストアは pgvector 一本化、融合はサービス層 RRF
- `AIAdapter.embed()` はインターフェース定義のみ（bedrock / ollama とも **スタブ**、
  `packages/adapters/ai/src/`）→ 本フェーズで実装
- メタデータの BM25 インデックス更新は API ルート同期実行（`services/search-index.ts`）→ 変更しない

### 確定事項（グリル結果）

| 論点        | 決定                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| 着手順序    | 仕様書先行（本書）。Phase 4 と依存がないため並行で実装に着手                      |
| v1 露出範囲 | Web 検索 UI + MCP/API の両方                                                      |
| モデル確定  | 暫定モデルで実装先行。ゴールデンセット評価は実データ投入後                        |
| 既定動作    | ハイブリッドは**デフォルト ON**。クエリパラメータ `semantic=false` で BM25 のみに |

### 暫定モデル

| 環境          | モデル                      | 次元 | 備考                               |
| ------------- | --------------------------- | :--: | ---------------------------------- |
| AWS           | Bedrock Titan Embeddings v2 | 1024 | Matryoshka 対応（512 へ縮小余地）  |
| 開発/オンプレ | Ollama bge-m3               | 1024 | MIT、8192 トークン、CPU 推論で実用 |

評価後の差し替えは「全件再埋め込み（rebuild）」で対応する前提（ADR-034 決定 5）。

## 2. 技術スタック（Phase 5a 追加分）

| カテゴリ            | 技術                     | 備考                                                           |
| ------------------- | ------------------------ | -------------------------------------------------------------- |
| ベクトル拡張        | pgvector                 | Aurora: `CREATE EXTENSION vector` / ローカル: イメージ差し替え |
| PostgreSQL イメージ | `pgvector/pgvector:pg16` | alpine → Debian 変更。既存環境は dump/restore or REINDEX       |
| ローカル埋め込み    | `ollama/ollama`          | compose デフォルトスタックで起動。モデルはボリューム永続化     |
| ORM 型              | drizzle-orm `vector` 型  | 次元指定なし列（モデル変更時に DDL 不要）                      |

## 3. アーキテクチャ概要

### 書き込みフロー（文書側・非同期）

```
[API] package CUD
  ├─ BM25 インデックス更新（既存・同期のまま）
  └─ embed ジョブ投入（QueueAdapter、AIAdapter が embed 可能な場合のみ）
        │
[Worker] embed-package ジョブ
  1. package 取得 → 埋め込み対象テキスト生成（title + notes + tags + リソース name/description）
  2. コンテンツハッシュ比較 → 変化なしならスキップ
  3. AIAdapter.embed(text, { type: 'document' })
  4. UPDATE package SET embedding, embedding_model, embedding_hash
```

### 検索フロー（クエリ側・同期）

```
[API] GET /api/v1/search?q=...&semantic=(true)
  ├─ 並列実行
  │   ├─ BM25: SearchAdapter.search()（既存。highlights / matchedResources はこちらが正）
  │   └─ ベクトル: embed(q, {type:'query'})（lru-cache）→ pgvector top-k（可視性フィルタ適用）
  ├─ サービス層 RRF 融合（k=60、上位から limit 件）
  └─ レスポンス（ベクトル由来ヒットは matchSource: 'semantic'）
```

- `semantic=false`、NoOp 環境、クエリ埋め込み失敗時は BM25 のみ（既存挙動と完全一致）
- ページネーションはハイブリッド時 RRF 結果リストに対して行う。`total` は BM25 側の値を維持し、
  ベクトル追加ヒットぶんの厳密性は求めない（実装時に UI 表記を整理）

## 4. Step 1: AIAdapter 拡張と実装

### 4.1 インターフェース拡張（`packages/adapters/ai/src/adapter.ts`）

```typescript
export interface EmbedOptions {
  /** 'query' | 'document' — e5 系プレフィックス等をアダプター内で吸収 */
  type?: 'query' | 'document'
}

export interface EmbeddingInfo {
  model: string // 例: 'amazon.titan-embed-text-v2:0', 'bge-m3'
  dimensions: number // 例: 1024
}

/** ベクトル空間キー「モデル名@次元数」— 保存(embedding_model)・検索・キャッシュの比較単位。
 *  Matryoshka モデルは同名のまま次元を変えられるため、次元をキーに含める */
export function embeddingKey(info: EmbeddingInfo): string // → 'bge-m3@1024'

export interface AIAdapter {
  complete(prompt: string, options?: CompleteOptions): Promise<string>
  embed(text: string, options?: EmbedOptions): Promise<number[]>
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>
  /** 埋め込み不可（NoOp 等）なら null — capability 判定に使う */
  getEmbeddingInfo(): EmbeddingInfo | null
}
```

### 4.2 実装

- **bedrock.ts**: Titan v2（`InvokeModel`）。`dimensions: 1024` を明示指定。
  `embedBatch` は並列呼び出し（Titan にバッチ API はないため p-limit で同時数制御）。
  モデル ID が `cohere.embed*` の場合は Cohere 形式（`texts` 配列 + `input_type` の
  query/document 非対称、最大96件/回の真のバッチ）に切り替わる — Cohere Embed v4
  （128K トークン、東京リージョン対応）を Titan の挑戦者として評価可能にするため
- **ollama.ts**: `POST /api/embed`（バッチ対応あり）。モデル名は env で指定（既定 `bge-m3`）
- **noop.ts**: `getEmbeddingInfo()` → `null`、`embed()` は throw
- **openai.ts**: `text-embedding-3-small` で同様に実装。位置づけは **OpenAI 互換
  エンドポイント用コネクタ**（vLLM / HuggingFace TEI 等のセルフホスト推論サーバーに
  `baseUrl` 差し替えで接続する用途）。公式サポートは Bedrock / Ollama の2系統

### 4.3 環境変数（`packages/shared/env.ts`）

| 変数                 | 既定値   | 用途                                 |
| -------------------- | -------- | ------------------------------------ |
| `AI_EMBEDDING_MODEL` | 実装既定 | アダプター毎の埋め込みモデル名上書き |

> 運用側の停止スイッチ（env `SEARCH_HYBRID`）は一度導入を検討したが**廃止**した。
> プロバイダ障害はタイムアウト + BM25 フォールバックで自動 degrade し（§7.4）、
> 品質・コスト起因の停止は**管理画面からの操作**として設計する（ADR-034 残課題 8、後続）。

## 5. Step 2: DB スキーマ + インフラ

### 5.1 マイグレーション（`packages/db`）

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE package
  ADD COLUMN embedding vector,            -- 次元指定なし（モデル差し替え時 DDL 不要）
  ADD COLUMN embedding_model text,        -- ベクトル空間キー「モデル名@次元数」（embeddingKey()、不一致検出用）
  ADD COLUMN embedding_hash text;         -- 対象テキストの SHA-256（再埋め込みスキップ）
```

- HNSW / IVFFlat インデックスは**張らない**（v1 は exact search。ADR-034 §2）
- 検索時は `embedding_model = <現行キー>` の行のみ対象。キーは「モデル名@次元数」で、
  Matryoshka モデル（Titan v2 等）が同名のまま次元を変えても別空間として扱われ、
  移行中の混在で pgvector が次元不一致エラーを起こさない

### 5.2 compose.yml

- `postgres` イメージを `pgvector/pgvector:pg16` へ変更。
  **開発環境はボリューム再作成を推奨**（alpine → Debian の collation 差。ADR-034 影響）
- Ollama サービス追加（開発・オンプレ共通構成、dev/prod パリティ）:

```yaml
ollama:
  image: ollama/ollama
  ports:
    - '127.0.0.1:${OLLAMA_PORT:-11435}:11434' # 11435: ネイティブ Ollama との衝突回避
  volumes:
    - ollama-models:/root/.ollama # 閉域はこのボリュームを事前配送
```

- デフォルトスタックで起動（profile 不要）。モデルは `ollama-init`（ワンショットコンテナ）が
  `AI_TYPE=ollama` のときだけ自動取得。取得済み・閉域（ボリューム事前配布）ではスキップ

### 5.3 AWS（infra/）

- Aurora へのマイグレーションで `CREATE EXTENSION` が流れる（追加 CDK 変更なし）
- Bedrock 埋め込みは**デフォルト有効**（`EnvironmentConfig.bedrock: false` でオプトアウト）—
  web / worker 両タスクに `AI_TYPE=bedrock` 等の環境変数を注入し、`bedrock:InvokeModel` を
  対象モデルの foundation-model ARN に限定して許可（モデル ID は CDK 側で解決し env と IAM で共有）
- Bedrock のモデルアクセス事前設定は不要（モデルアクセスページは廃止済み — サーバーレス
  基盤モデルは初回呼び出しで自動有効化され、アクセス制御は IAM に一本化）
- しきい値の既定は**各 AI アダプターが内部に持つ**（`EmbeddingInfo.recommendedMinSimilarity`。
  demo のゴールデンセット39クエリで実測、2026-07-07。モデルごとに日本語ペアの
  コサイン類似度分布が大きく異なるため、単一の既定値は流用不可）:
  - Titan v2 → **0.15**（上限性能の 97% を維持、正解なしクエリの擬似ヒット1件）
  - Cohere Embed v4 → **0.3**（上限の 99%、擬似ヒット 0〜1件）
  - bge-m3（Ollama）→ **0.45**（実データ実測: 関連 0.47〜0.62 / ノイズ 0.38〜0.45）
  - 解決順序: env `SEARCH_VECTOR_MIN_SIMILARITY`（CDK では `bedrock.vectorMinSimilarity`）>
    アダプター推奨値 > フォールバック 0.45。CDK を使わないデプロイ（compose / オンプレ）でも
    モデルを選ぶだけで適正しきい値が効く。モデル変更時は要再測定
  - この基準値に対し、管理画面（`/dashboard/admin/site`）から **±4目盛り（1目盛り 0.025）**
    のオフセットを再デプロイなしで適用できる。セマンティック検索全体のオン/オフも
    同画面から切替可能（オフ時はクエリ埋め込みごとスキップ）。いずれも `system_setting`
    テーブル、反映は最大30秒（ADR-036）
- **モデル選定の実測結果**: Cohere Embed v4（nDCG 75）> Titan v2（nDCG 70）、
  特に質問文で +12pt。ただし Cohere は **AWS Marketplace モデル**のため、初回のみ
  管理者権限での invoke 1回（+数分の伝播待ち）でアカウント購読の有効化が必要 —
  デフォルトは摩擦ゼロの Titan とし、Cohere は environments.ts でのオプトイン

## 6. Step 3: 埋め込み生成パイプライン

### 6.1 キュージョブ

- 新ジョブタイプ `embed-package`（payload: `{ packageId }`）
- 投入箇所: `services/search-index.ts` の package インデックス更新（`indexPackageMetadata()`）
  **および** リソースインデックス更新（`indexResourceMetadata()`）に追記 — リソース CUD 時も
  親 package を再埋め込みする（埋め込みテキストにリソースメタデータを含むため）
- 投入条件は **capability（`getEmbeddingInfo() !== null`）のみ**。`SEARCH_HYBRID` では
  ゲートしない — このフラグは検索時にベクトルを「読む」ことだけを止める緊急停止スイッチで、
  一時停止中も書き込みは継続し、再有効化時にベクトルが陳腐化していないことを保証する
- package 削除時は行ごと消えるため追加処理不要

### 6.2 Worker ハンドラ（`apps/worker`）

1. package 取得（deleted なら終了）
2. 対象テキスト生成（active リソースのメタデータを連結、トークン上限で切り詰め）:
   `title + '\n' + notes + '\n' + tags.join(' ') + '\n' + resources.map(r => r.name + ' ' + (r.description ?? '')).join('\n')`
3. SHA-256 を `embedding_hash` と比較 → 一致かつ `embedding_model` 一致ならスキップ
4. `embed(text, { type: 'document' })` → `UPDATE package SET embedding, embedding_model, embedding_hash`
5. 失敗時は既存のリトライ機構に乗せる（埋め込み欠損は検索品質低下のみで機能欠損にならない）

### 6.3 バルク再埋め込み

- 既存の検索インデックス rebuild フローに `--embeddings` 相当を追加:
  全 active package を `embedBatch` で処理（レート制御付き）
- モデル・次元の差し替え手順: env 変更（`AI_EMBEDDING_MODEL` / `AI_EMBEDDING_DIMENSIONS`）→
  rebuild 実行（`embedding_model` のキー不一致行が全て再生成される）

## 7. Step 4: ハイブリッド検索

### 7.1 ベクトル検索（`packages/adapters/search` の PG 実装に追加）

```typescript
/** pgvector cosine distance による top-k。SearchFilters の可視性 WHERE を必ず適用。
 *  modelKey は embeddingKey() のベクトル空間キー「モデル名@次元数」（裸のモデル名ではない） */
searchByVector(vector: number[], modelKey: string, filters: SearchFilters, k: number): Promise<VectorHit[]>
```

- `ORDER BY embedding <=> $vector LIMIT k`（k=50）
- 類似度しきい値: cosine similarity **既定 0.45** 未満を除外 — kNN が無関係な結果まで
  k 件埋めるのを防ぐ。実データ + bge-m3 の計測で関連ヒットは 0.47〜0.62、無関係の
  テールは 0.38〜0.45 に分布。モデル依存のため `SEARCH_VECTOR_MIN_SIMILARITY` で
  環境ごとに調整可（最終値はゴールデンセット評価で確定）
- OpenSearch アダプターには実装しない（ベクトルは PG 一本化。ADR-034 方式 P）

### 7.2 RRF 融合（サービス層・全環境共通）

```
score(doc) = Σ 1 / (60 + rank_i(doc))   // BM25 順位 + ベクトル順位
```

- BM25 top-50 + ベクトル top-50 → RRF → offset/limit 適用
- matchedResources / highlights は BM25 結果から引き継ぐ
- facets は BM25 集計にウィンドウ内のベクトル専用ヒット分を加算（`facetsForIds`）、
  total は max(BM25 total, 融合件数) — どちらもベクトル側の寄与は FUSION_WINDOW
  までという同じ近似を持つ
- ページング: 融合リスト（最大 2×FUSION_WINDOW 件）の範囲内は融合順で応答する。
  開始位置が融合リストを超え、かつ BM25 総数がそこまで届く場合のみキーワード順の
  ページングにフォールバック — 先頭ページが報告した total とその後のページが
  矛盾して空ページを踏む事故を防ぐ
- ベクトルのみでヒットした doc は `matchSource: 'semantic'`、ハイライトなし
- `q` が空（ブラウズ）のときはベクトル検索を実行しない（既存挙動のまま）

### 7.3 クエリ埋め込みキャッシュ

- `packages/shared` の lru-cache ユーティリティ（ADR-004）
- キー: `${model}:${normalizedQuery}`、TTL 1h / max 1000 件

### 7.4 API

- `GET /api/v1/search` に `semantic` パラメータ追加（既定 `true`）
- degrade 条件（いずれかで BM25 のみ）: `semantic=false` / `getEmbeddingInfo() === null` /
  クエリ埋め込みの失敗・**タイムアウト**（error ログのみ、検索は成功させる。タイムアウトは
  短め（目安 2s）に設定し、プロバイダ障害時に全検索が高遅延化することを防ぐ）
- MCP のデータセット検索ツールは同じサービスを通るため追加実装なし

## 8. Step 5: Web UI（`apps/web`）

- 検索結果ページ: 変更最小。ベクトル由来ヒット（`matchSource: 'semantic'`）は
  ハイライトなしのため title/notes をプレーン表示 + 「関連」バッジ表示
- i18n: バッジ文言（ja/en）
- 検索設定 UI（セマンティック ON/OFF トグル）は v1 では作らない（URL パラメータのみ）

## 9. Step 6: ゴールデンセット評価

- `packages/api/scripts/golden-queries.yaml`: 20〜50 問（類義語 / 自然文 / **完全一致** を
  必ず混在）。作成は実データ投入後に人手で行う。デプロイ環境固有のためコミットせず、
  同ディレクトリの `golden-queries.example.yaml`（記入ガイド付き）からコピーして作成
- `packages/api/scripts/eval-search.ts`（`pnpm eval:search`）: 検索 API を叩き
  Recall@10 / nDCG@10 を semantic ON/OFF で比較出力。完全一致クエリの劣化検知で exit 1
- **出荷条件**: 完全一致クエリで `semantic=false` 比の劣化なし（ADR-034 決定 8）。
  劣化があれば RRF 重み・しきい値を調整、解消しない場合はデフォルト OFF に切り替えて出荷

## 10. テスト戦略

| 種別     | 対象                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| ユニット | RRF 融合ロジック、埋め込み対象テキスト生成 + ハッシュ、EmbedOptions 分岐                    |
| ユニット | アダプター: noop の capability、ollama/bedrock はモック HTTP                                |
| 統合     | pgvector クエリ（可視性フィルタ含む）、embed-package ジョブ、rebuild                        |
| E2E      | Ollama profile 起動下でハイブリッド検索 → 類義語ヒット確認、`semantic=false` で既存挙動一致 |

## 11. 実装順序

1. **Step 1**: AIAdapter 拡張 + 実装（bedrock / ollama / openai / noop）
2. **Step 2**: マイグレーション + compose.yml（pgvector イメージ、Ollama profile）
3. **Step 3**: embed-package ジョブ + rebuild 拡張
4. **Step 4**: ベクトル検索 + RRF + API パラメータ
5. **Step 5**: Web UI（バッジ・プレーン表示）
6. **Step 6**: 評価スクリプト（ゴールデンセット本体は実データ後）

Step 1〜3 と Step 4 は独立性が高く、Step 3 完了前でも Step 4 は着手可能
（埋め込み済み行が少ないだけで動作する）。

## 12. スコープ外（後続）

- リソースコンテンツ（PDF 等）の埋め込み → ADR-034 残課題 5（ベクトルストア再評価込み）
- 関連データセット推薦（「似ているデータセット」）→ ADR-034 残課題 6
- 管理画面からのハイブリッド検索停止（品質・コスト起因の運用停止）→ ADR-034 残課題 8
- ADR-032 Part B（`query_resource`）→ 本フェーズとは独立に実施
- 埋め込みモデルの最終確定 → ゴールデンセット評価後
