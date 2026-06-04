# ADR-013: 全文検索と DB フィルタリングの責務分離

## ステータス

**承認済み（Accepted）**

## コンテキスト

CKAN はデータセット一覧・フィルタリング・キーワード検索のほぼすべてを Solr に委譲している。
この設計はファセット検索等で強力だが、以下の運用課題が知られている：

- DB → Solr のインデックス同期遅延により、作成直後のデータセットが一覧に表示されない
- Solr インデックスの破損・不整合時に `search-index rebuild` が必要
- 検索エンジン障害時に一覧表示を含むサイト全体が影響を受ける

KUKAN では OpenSearch を検索エンジンとして採用している（ADR-009）が、
すべてのクエリを検索エンジンに委譲するか、DB 直接クエリと使い分けるかを決定する必要がある。

## 検討した選択肢

### A) 全クエリを検索エンジン経由（CKAN 方式）

- 良い点: ファセットカウント・関連度スコアリングが全ページで統一的に利用可能
- 問題点:
  - インデックス同期遅延が一覧ページにも影響する
  - 検索エンジン障害時にサイト全体が機能停止
  - 小規模デプロイ（LGWAN 等）でも検索エンジンが必須になる
  - フィルタリング用フィールドもすべてインデックスに含める必要がある

### B) DB 直接 + 検索エンジンの責務分離 — 採用

- 良い点:
  - 一覧・フィルタリングは常に最新データ（DB が Single Source of Truth）
  - 検索エンジン障害時も一覧・フィルター系ページは影響を受けない
  - インデックスはキーワード検索に必要なフィールドのみで軽量
  - 小規模デプロイでは検索エンジンなしで基本機能が完全に動作
- 問題点:
  - キーワード＋フィルター複合検索で検索エンジンとDBの連携が必要

## 決定

**公開検索は SearchAdapter（OpenSearch）経由、ダッシュボードの一覧・管理は常に DB 直接（PostgreSQL）とする。**

### 責務の分担

| 操作                                     | データソース                      | エンドポイント                        |
| ---------------------------------------- | --------------------------------- | ------------------------------------- |
| 公開キーワード全文検索                   | `search`（SearchAdapter）         | `GET /api/v1/search?q=...`            |
| 公開一覧（検索・フィルター・ファセット） | `search`（SearchAdapter）         | `GET /api/v1/packages`                |
| CKAN 互換検索                            | `search`（SearchAdapter）         | `GET /api/3/action/package_search`    |
| **ダッシュボード一覧・管理**             | **`dbSearch`（PostgreSQL 固定）** | `GET /api/v1/packages?my_org=true`    |
| 組織一覧・グループ一覧                   | DB 直接                           | `GET /api/v1/organizations`, `groups` |
| 組織詳細（所属データセット）             | DB 直接                           | `GET /api/v1/organizations/:id`       |
| パッケージ詳細・リソース一覧             | DB 直接                           | `GET /api/v1/packages/:id`            |

### デュアルアダプター構成

AppContext に2つの SearchAdapter を注入する：

| コンテキスト変数 | アダプター                            | 用途                           |
| ---------------- | ------------------------------------- | ------------------------------ |
| `search`         | 設定に従う（OpenSearch / PostgreSQL） | 公開検索・インデックス書き込み |
| `dbSearch`       | 常に PostgresSearchAdapter            | ダッシュボード読み取り         |

```typescript
// packages/api/src/adapters.ts
const dbSearch = new PostgresSearchAdapter(db) // 常に PostgreSQL
let search =
  env.SEARCH_TYPE === 'opensearch'
    ? new OpenSearchAdapter({ endpoint: env.OPENSEARCH_URL })
    : dbSearch // postgres の場合は共用
```

`my_org=true`（ダッシュボード）の場合に `dbSearch` を使用：

```typescript
// packages/api/src/routes/packages.ts
const search = my_org ? c.get('dbSearch') : c.get('search')
```

これにより：

- **ダッシュボード**: CUD 直後でも即座に最新データが表示される（DB が Single Source of Truth）
- **公開検索**: OpenSearch の kuromoji 形態素解析・関連度スコアリングが利用可能
- **インデックス書き込み**: CUD 時に `search`（OpenSearch）へ即座にインデックス更新
- **SEARCH_TYPE=postgres**: `search` と `dbSearch` が同一インスタンスになり、追加コストなし

### キーワード＋フィルター複合検索の方針

SearchAdapter でキーワードとフィルターが同時に指定された場合：

- **OpenSearch**: filter context（スコアに影響しない bool filter）でフィルタリング
- **PostgreSQL**: ILIKE + WHERE 句でフィルタリング

検索エンジン側にフィルター用フィールド（`organization`, `tags`, `formats` 等）を持たせ、
SearchAdapter が一貫してフィルタリング・ファセット集計・ページネーションを担当する。

### リソースメタデータ検索

`q` パラメータ指定時は、パッケージ自体（name/title/notes）に加えて、
紐づくリソースの name/description も検索対象に含める。
マッチしたリソースがある場合は `matchedResources` 配列としてレスポンスに付与する。

- **OpenSearch**: nested query + inner_hits で検索
- **PostgreSQL**: EXISTS サブクエリで ILIKE 検索

## 影響

- ダッシュボードは `dbSearch`（PostgreSQL 固定）を使用するため、インデックス同期遅延の影響を受けない
- 公開検索は `search`（OpenSearch）で高精度な日本語全文検索が利用可能
- CUD 操作時に `indexPackage()` で `search` アダプターへ即座にインデックス更新
- LGWAN 等の閉域網環境では `SEARCH_TYPE=postgres` で全機能が完全に動作
- `SEARCH_TYPE=postgres` の場合、`search` と `dbSearch` は同一インスタンスであり追加コストなし

## 関連 ADR

- ADR-005: 4つのアダプターのみ（SearchAdapter）
- ADR-009: OpenSearch + ILIKE フォールバック
