# ADR-060: CKAN 互換 API を CKAN 2.12 の読み取りに合わせる

## ステータス

**承認済み（Accepted）** — 2026-10-03

`/api/3/action/*` の読み取りアクションを、呼び出し方・応答の形・失敗の返し方まで
CKAN 2.12 に合わせる。読めない指定は無視せず断る。書き込みのアクションは本 ADR の範囲外とする。

## コンテキスト

CKAN 互換 API は Phase 1 で、REST API の結果の一部の項目名を snake_case に付け替える
薄い層として作られた。リソースの `extras` を設定できるようにする作業で、本家（CKAN 2.12 の
ソース、ckanapi、ckanext-harvest）と突き合わせたところ、次のことがわかった。

### 1. 本家のクライアントから呼べない

- **POST に応じない**（404）。ckanapi の `RemoteCKAN` は既定で POST を使う（`get_only=False`）
  うえ、版番号なしの `/api/action/` を呼ぶ。サイトのドキュメントに載せていた ckanapi の例は
  動かなかった
- トークンは `Bearer` 付きしか読まない。ckanapi は `Authorization: <token>` と
  `X-CKAN-API-Key` で送る
- `package_search` は `fq`・`sort`・`facet.*`・`include_private` を**黙って無視**していた。
  ckanext-harvest の CKAN ハーベスターは、差分取得に `fq=metadata_modified:[X TO *]`、
  ページ送りに `sort=id asc` を使うので、毎回全件が返っていた
- `package_list` は検索の上限で 1000 件に切れていた

### 2. 形が違う

- 付け替え漏れ（`author_email`、`maintainer_email`、`url_type`、`image_url` など）
- 本家にある項目がない（`num_resources`、`num_tags`、`isopen`、`license_url`、タグの
  `display_name` など）
- `extras` の形：本家はデータセット・組織・グループが `[{key, value}]`、リソースはトップレベルに
  展開する。KUKAN はどれもオブジェクトのまま返していた
- アップロードしたリソースの `url` がファイル名だけで、CKAN のクライアントからは取得できない
- 失敗の `__type` が常に `Validation Error`

### 3. 内部の値が出ている

リソースの応答に `contentRevision`、`pendingStorageKeyAt`、`pipelineStatus` などが載っていた。
本家では、リソースのトップレベルの知らない項目は **extras として扱われる**。CKAN が KUKAN を
ハーベストすると、これらは相手のサイトに extras として保存される。

## 検討した選択肢

### A) 今の薄い層のまま、違いを文書に書く

変更は最小だが、本家のクライアントがそのまま動かない状態が続く。互換 API を置く理由が
「既存の CKAN の道具から読めること」である以上、目的を果たしていない。

### B) 読み取りを本家に合わせる — 採用

項目は REST の応答から付け替えるのではなく、**CKAN の形を項目ごとに書き起こす**
（`packages/api/src/routes/ckan/format.ts`）。KUKAN に列が増えても、CKAN で何と呼ぶかを
決めるまでは互換 API に出ない。

### C) 書き込みまで含めて合わせる

`package_create` / `resource_create`（multipart のアップロード）/ `*_update` / `*_patch` は、
下書き（ADR-039）や検証エラーの形との対応を要する別の規模の作業である。本 ADR では扱わない。

## 決定

### 1. 呼び出し方

- 各アクションは GET（クエリ文字列）と POST（JSON の本文またはフォーム）の両方に応じる
- `/api/3/action` と `/api/action` の両方に置く
- トークンは `Bearer` に加えて、`/api/(3/)action/` に限り `Authorization: <token>` と
  `X-CKAN-API-Key` も読む。REST API の約束（`Bearer` のみ）は変えない
- POST の本文は読む前に 1 MiB で打ち切る（413）。読み取りのアクションは multipart を受けない
- 引数の既定値・上限は本家に合わせる（`package_search` の `rows` は既定 10・上限 1000、
  `organization_list` は `title asc`、`all_fields` 時の `limit` 上限 25 など）。
  `package_search` の `include_private` も本家どおり既定で `false` とする
- `organization_show` / `group_show` の件数とデータセット、`tag_show` のデータセットは、呼び出し元の
  見える範囲で数える（一覧の件数と同じ）。`include_datasets` の上限は本家どおり組織 10 件・グループ
  1000 件

### 2. 失敗の返し方

本家の `views/api.py` と同じく、404 は `Not Found Error`、引数の誤りは 409 の
`Validation Error`（引数名ごとの理由の dict）、権限は 403 の `Authorization Error` で返す。
知らないアクションと壊れた JSON は 400 で、本文はエンベロープのない文字列とする。
`help` は `help_show` の URL とし、`help_show` も置く。

### 3. 読めない指定は断る

`fq` は、空白で区切った AND の条件のうち、KUKAN の検索で表せるもの
（`organization`、`owner_org`、`groups`、`tags`、`res_format`、`license_id`、`capacity`、
`metadata_modified` の範囲など）だけを解釈する。`OR`・否定・括弧・知らない項目は **409 で断る**。`site_id` も、比べるサイトの識別子がないので断る。
`sort` も、検索が並べられる 1 項目（と `score`）を超える指定は断る。`score` を先頭に置くと、
`q` があるときは検索の順位（同順位は更新日時の新しい順）で並べる。このとき `score` に続けられるのは
`metadata_modified desc` だけで、ほかは表せないので断る。`q` がないときは順位がすべて等しいので、
続く項目で並べる（Solr と同じ）。項目の後ろに置いた `score`（同値の順位付け）は表せないので断る。日付は Solr と同じく末尾 `Z` の UTC だけを受け、タイムゾーンのない
時刻をサーバーの地方時として読むことはしない。

黙って無視すると、頼んだより広い結果が返り、呼び出し側は気づけない。今回見つかった
ハーベスターの全件取得がまさにそれだった。

そのために、検索アダプターに更新日時の範囲（`updatedFrom` / `updatedTo`）と `id` での並びを
足した。

### 4. リソースのトップレベルには、人が付けたものだけを載せる

本家の約束では、リソースのトップレベルの知らない項目は extras である。そこで、CKAN の標準の
項目のほかに載せるのは、**リソースの `extras` と `section`（ADR-050）だけ**とする。
パイプラインやヘルスチェックの内部の値は載せない。

衝突の扱いは次のとおり。

- CKAN の標準の項目名と `section` は、`extras` の予約キーとして書き込みのときに拒否する。
  予約より前に保存された値があっても、出力では標準の項目と `section` を優先する

### 5. 出さないもの

- **組織・グループのメンバー（`users`）と `member_count`。** KUKAN はメンバーの人数を
  メンバーにしか見せていない（`orgMemberCountSql`）。互換 API のためにこの方針を崩さない。
  空のリストにはせず、項目ごと出さない（空のリストは「メンバーはいない」と読める）
- データセットの AI 生成の項目と品質スコア。AI が書いた文を CKAN の項目に混ぜない
  （ADR-053 §10.1 と同じ理由）
- 本家にあって KUKAN に対応するものがない項目（`relationships_as_*` など）は、空や 0 で埋める

## 影響

- **今の CKAN 互換 API の利用者から見ると、互換性を壊す変更である。** `extras` の形、
  項目名の付け替え、独自の項目の削除、`package_search` の既定（`rows`、`include_private`）、
  失敗のステータス（400 → 409）が変わる。リリースノートで知らせる
- REST API（`/api/v1`）の応答は、データセット詳細のグループに `description`・`imageUrl`・
  `created`、組織に `created` が増えるだけで、ほかは変わらない
- OpenSearch での `name` の並べ替えは、解析済みのテキスト項目を指していて失敗していた。
  `name.keyword` を使うように直した（REST の `sort_by=name` にも効く）

## 残課題

- 書き込みのアクション（選択肢 C）
- `q` の Solr の構文（`name:foo` など）は解釈せず、キーワードとして扱っている
- タグの語彙（vocabulary）がない。`tag_list` の `vocabulary_id` は断っている
- `status_show` など、一覧にないアクション

## 関連 ADR

- ADR-012: API のライブラリ化・単一オリジン
- ADR-013: 検索と DB のフィルタリングの分離
- ADR-017: サーバー経由のダウンロード（アップロードしたリソースの `url`）
- ADR-039: データセットの下書き
- ADR-050: リソースのセクション
- ADR-053: リソースの AI 生成抄録
