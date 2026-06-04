# ADR-025: OpenSearch parent-child インデックスへの統合

## ステータス

**承認済み（Accepted）** — 2026-05-31

ADR-021（判断 1）を置換する。

## コンテキスト

現在の検索は 3 つの OpenSearch インデックスで構成されている：

- `kukan-packages` — データセットメタデータ（title, name, notes, organization, tags 等）
- `kukan-resources` — リソースメタデータ（name, description, format, packageId）
- `kukan-contents` — リソースコンテンツ全文（extractedText, resourceId, packageId）

`msearch` で 3 インデックスを並列検索し、アプリケーション層でパッケージ単位にマージしている。
この設計には以下の問題が確認された：

### 問題 1: ファセットカウントの不整合

aggs（集計）はパッケージインデックスの検索結果にのみ基づく。
リソース名やコンテンツでマッチしたパッケージはマージ後に追加されるため、
ファセットの件数に反映されない。

例: パッケージの title に「東京観光」がなくリソース名に含まれる場合、
検索結果には表示されるがファセットカウントは 0 件になる。

### 問題 2: ファセットフィルタの未適用

リソース/コンテンツ検索にはファセットフィルタ（organization, tags 等）が適用されず、
フィルタ条件に合わないパッケージが検索結果に混入する。

### 問題 3: マージロジックの複雑さ

`mergeResourceHits`, `mergeContentHits`, `fetchPackagesByIds` など約 200 行のマージロジックが必要。
スコアリング、ページネーション、ハイライトの整合性維持が困難。

## 検討した選択肢

| 方式                     | 概要                                                            | メリット                                                             | デメリット                                                                 |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A. 2段階検索             | Phase 1 で packageId 収集、Phase 2 で ids+filter+aggs           | インデックス変更不要                                                 | スコアリング・ハイライト・ページングの整合性が取れない                     |
| B. パッケージに非正規化  | リソース名をパッケージドキュメントに埋め込む                    | 検索が単一クエリ（リソース名まで）                                   | リソース更新時にパッケージ再インデックス。コンテンツは別インデックスのまま |
| **C. parent-child 統合** | 単一インデックスに join フィールドで 3 ドキュメントタイプを統合 | 全問題を根本解決。1 クエリで検索・aggs・ハイライト・ページングが完結 | 再インデックス作業。同一シャード制約                                       |

## 決定: 方式 C — parent-child インデックスへの統合

### インデックス構造

```
kukan-search (単一インデックス)
  ├── type: "package"   (parent)
  │     title, name, notes, organization, tags, formats, ...
  ├── type: "resource"  (child of package)
  │     name, description, format
  └── type: "content"   (child of package)
        extractedText, resourceId, contentType
```

OpenSearch の join フィールドは 1 階層のみサポートするため、
resource と content は両方 package の子としてフラットに配置する。
content は論理的には resource の子だが、grandchild（package → resource → content）は
OpenSearch では不可。代わりに `resourceId` フィールドを保持し、
リソース単位の操作（deleteContent, getContentChunks 等）は term フィルタで対応する。

### 検索クエリ例

```json
{
  "query": {
    "bool": {
      "should": [
        { "multi_match": { "query": "東京観光", "fields": ["title", "notes"] } },
        {
          "has_child": {
            "type": "resource",
            "query": { "multi_match": { "query": "東京観光", "fields": ["name", "description"] } }
          }
        },
        {
          "has_child": { "type": "content", "query": { "match": { "extractedText": "東京観光" } } }
        }
      ],
      "minimum_should_match": 1,
      "filter": [{ "terms": { "organization": ["my-org"] } }]
    }
  },
  "aggs": {
    "organizations": { "terms": { "field": "organization" } }
  }
}
```

### 利点

- 検索・ファセット・フィルタ・ページングが 1 クエリで完結
- マージロジック（`mergeResourceHits`, `mergeContentHits`, `fetchPackagesByIds`）が不要に
- ファセットカウントが全ソース（パッケージ + リソース + コンテンツ）のマッチを正確に反映
- フィルタがパッケージレベルで一元適用される

### 制約・注意点

- **同一シャード制約**: 子ドキュメントは親と同じシャードに配置される（`routing` パラメータで制御）
- **ドキュメント数**: パッケージ数 × (リソース数 + チャンク数) に増加するが、数万パッケージ規模なら問題なし
- **子ドキュメントの更新**: リソース/コンテンツの追加・削除時に `routing=packageId` が必要
- **再インデックス**: 既存 3 インデックスからの移行が必要
- **inner_hits**: リソース/コンテンツのハイライトを取得するには `has_child` + `inner_hits` を使用

### 移行計画

1. 新しいインデックスマッピング定義（join フィールド + kuromoji analyzer）
2. `OpenSearchAdapter` の CRUD メソッドを新構造に対応
3. 検索メソッドを `has_child` クエリに書き換え（マージロジック削除）
4. マイグレーションスクリプト作成（3 インデックス → 1 インデックス）
5. 管理画面の reindex 機能を新構造に対応

## 参考

- [OpenSearch Join field type](https://opensearch.org/docs/latest/field-types/supported-field-types/join/)
- [OpenSearch has_child query](https://opensearch.org/docs/latest/query-dsl/joining/has-child/)
- ADR-021: リソースデータ本体の全文検索インデックス（判断 1 を本 ADR で置換）
