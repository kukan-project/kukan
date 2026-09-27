# ジョブ実行時リファレンス

ジョブキュー（ADR-058）に**どのジョブが・誰から積まれ・何を積み・何で排他しているか**をまとめたもの。

リソース 1 件の 1 回の実行の中身は `docs/pipeline.md` にある。ここに書くのはその外側、
ジョブどうしの関係である。ジョブを足す・積む場所を変えるときは、この文書も更新する。

| 参照             | 場所                                                           |
| ---------------- | -------------------------------------------------------------- |
| ジョブ種別の定義 | `packages/shared/src/pipeline-types.ts`                        |
| ハンドラ         | `apps/worker/src/index.ts`                                     |
| キュー本体       | `packages/adapters/queue/src/postgres.ts`                      |
| 管理画面の起点   | `packages/api/src/routes/admin.ts`                             |
| 設計判断         | `docs/adr/jp/058`（キュー）/ `044`（claim）/ `054`（埋め込み） |

## 1. キューの性質

- 表 1 つ（`job`）。取り出しは `run_at` の順で、優先度は無い。
- worker は 1 タスクにつき 1 件ずつ直列に処理する。複数タスクなら `SKIP LOCKED` で分け合う。
- リースは 600 秒で、処理中は延長し続ける（上限 90 分）。3 回取られて終わらなければ `dead`。
- 待ち件数でスケールする（`JobsWaiting`）。件数であって、所要時間は見ていない。

所要時間はジョブによって、また同じジョブでも中身によって 4〜5 桁違う。同じ列に並ぶ。

| ジョブ              | 空振りのとき                                              | 仕事があるとき                                   |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `embed-package`     | 全リソースのハッシュが一致。DB を読むだけで AI を呼ばない | 変わったリソースを 32 件ずつ埋め込み API へ送る  |
| `sync-resource-doc` | 印が無くても書き（印の確認が書き込みの後）、約 1 秒待つ   | 約 1 秒。ほとんどが `refresh: 'wait_for'` の待ち |
| `summarize-package` | 抄録があり版が同じ（ただし材料は読む）                    | LLM を呼ぶ。数秒〜数十秒                         |
| `resource-pipeline` | 同じバイト列で Interpret と Index を飛ばす                | 大きいファイルで十数分                           |

`resource-pipeline` 以外の空振りは、積まなくてよかったジョブである。積む側は、材料が変わったかを
書き込みの時点で知っている。`resource-pipeline` は取得してみるまで中身が同じか分からないので、
空振りは避けられない。

`embed-package` / `embed-all-packages` は名前に反してデータセットの埋め込みを作らない。
埋め込みはリソースにだけある（ADR-054）。データセット単位で積むのは、材料にデータセットの
title・tags が入ることと、debounce（`package.embedding_queued_at`）をデータセット単位で取っている
ためで、1 回のジョブが配下の全リソースを読み、変わったものだけを埋め込む。名前はベクトルが
データセットに 1 本だった頃（ADR-034）のもの。

## 2. ジョブごとの処理

「積む」は §3 の図の矢印にあたる。「claim」はリソースの実行 claim（§6）。「印」「窓」などの用語は §8。

### リソース単位

**`resource-pipeline`** `{ resourceId, rebuildOnly? }` — 1 リソースを処理する。中身は `docs/pipeline.md` §1。

1. claim を取る。取れなければ、遅延（`CLAIM_RETRY_DELAY_S`）つきで同じ引数のまま積み直して終わる。
2. Fetch。外部 URL なら取得し、アップロードなら保存済みのオブジェクトを使う（`rebuildOnly` は取得しない）。
   同じホストへの取得間隔が足りなければ、遅延つきで積み直して終わる。
3. Version。バイト列を版として確定する（中身が同じなら版を作らない）。
4. Interpret。プレビュー（Parquet など）と schema を作る。表があればその場で Lake に取り込み、失敗したら
   `lake-ingest-version` を積む。版を作らず、派生物がこのバイト列から作られていれば、Interpret と Index を
   飛ばす（`derivativesReused`。`rebuildOnly` はこの判定を通らない）。
5. Index。テキストを抽出し、500 KB のチャンクに分けて 1 件ずつ OpenSearch に書く（各 `wait_for`）。
   書くのは本文チャンクだけで、リソース文書は書かない。
6. Summarize（`AI_SUMMARY_MODEL` があるサイトだけ）。抄録を書いたら `embed-package` と `sync-resource-doc`
   を積み、書かなかったら `sync-resource-doc` だけを積む。
7. claim を返す。

**`lake-ingest-version`** `{ resourceId, version }` — 層 2 への取り込みをやり直す。

1. その版がまだ層 2 に入っていないかを DB に聞く（sweep と同じ述語）。入っていれば 5 へ。
2. claim を取る。取れなければ、遅延つきで積み直して終わる。
3. 版ファイルをもう一度解釈し（前回の Parquet は使わない）、DuckLake に取り込み、版に schema を記録する。
4. 失敗したら版の失敗回数を数えて終わる（例外にしない。上限に達したら諦める）。
5. 同じリソースで次に未取込の版があれば、その `lake-ingest-version` を積む。

**`sync-resource-doc`** `{ resourceId }` — 1 リソースの検索文書を行から書き直す。OpenSearch が無い
サイトでは何もしない。

1. 印（`doc_sync_due_at`）を読む。
2. リソースとデータセットがどちらも `active` の行を読む。無ければ書かない（下書きは公開時に書かれる）。
3. 文書を組み立てる。`id` / `packageId` / `name` / `description` / `format` / `section` / `summary`。
   `summary` は編集者が非表示にしていれば null（ページの表示と同じ判定）。
4. `index` API で文書全体を上書きする（データセットの子、`routing` はデータセット id、`wait_for`）。
   **印の有無にかかわらず書く。**
5. 1 で印があれば、同じ値のときだけ消す（CAS）。処理中に立った新しい印は残す。

7 つのフィールドのうち、API の外で変わるのは `summary` だけである（ほかは API の編集が直接書く）。

**`purge-resource-version`** `{ resourceId, version }` — 版を 1 つ取得不能にする（ADR-043 §5）。

1. claim を取る。取れなければ Conflict で失敗し、キューが再試行する。
2. 版が `purging` でなければ何もしない。
3. 版ファイルを消す。
4. 配信中の版なら、プレビューなどの派生物・本文チャンクを消し、`contentIndexed` を false にし、層 2 から
   外し、配信の指す先を 1 つ前の `active` の版へ戻す（無ければ空にする）。配信中でなければ層 2 だけ扱う。
5. 作り直しが要る印があれば、`resource-pipeline(rebuildOnly)` を積む（印の消去と同じトランザクション）。
6. 版を `purged`（墓標）にし、監査ログを書く。

### データセット単位

**`embed-package`** `{ packageId }` — 配下リソースの埋め込みを作る（§1 の注記）。

1. 埋め込みが無効なサイト、データセットが `active` でないときは何もしない。
2. データセットの title・tags と、配下の `active` なリソースを読む。
3. リソースごとに埋め込みテキストを組み立て、SHA-256 を取る。非表示の抄録は入れない。
4. テキストが空のリソースは、ベクトルを消す。
5. ハッシュとモデルキーが前回と同じリソースは飛ばす。
6. 残りを 32 件ずつ埋め込み API へ送り、ベクトル・モデルキー・ハッシュを書き戻す。

**`summarize-package`** `{ packageId, after?, refresh }` — データセット内の次の 1 リソースに抄録を書く。

1. `after` より後で、配信中の版を持つリソースを id 順に 1 件探す。
2. 無ければ `embed-package` を積んで終わる（書いた件数にかかわらず積む）。
3. claim を取る。取れなければ、同じ `after` のまま遅延つきで積み直して終わる。
4. 抄録を判定・生成する（`executeSummarize`）。判定の順は、プロバイダが使えるか → 公開されているか →
   非表示でないか → 人が書いたものでないか → **材料をストレージから読む** → 同じ生成（モデル・プロンプト版・
   言語）で同じ版の抄録があるか → 同じ生成で拒否済みでないか → 生成。書くときは同じ文で印を立てる。
5. ファイルに理由がある skip は、理由を `summaryMeta` に記録する。
6. 結果にかかわらず `sync-resource-doc` を積む。
7. 次のリソースの `summarize-package` を積む。

**`purge-organization`** `{ organizationId }` — 削除済みの組織を完全に消す（ADR-028）。

1. 組織を `deleted` / `purging` から `purging` にする（durable claim）。できなければ何もしない。
2. 配下のデータセットとリソースを読み、全リソースの claim を 1 文で取る。1 つでも取れなければ Conflict で
   失敗し、再試行する。
3. データセットごとに、検索索引とストレージの外部データを消す（並行数に上限あり）。
4. 層 2 のテーブルをまとめて消す。
5. データセット（CASCADE で配下も）、使われなくなったタグ、組織の行を 1 トランザクションで消す。
6. 層 2 のストレージを回収する。

### 全件

**`embed-all-packages`** — 全データセットに `embed-package` を積む。

1. 埋め込みが無効なサイトでは何もしない。
2. `active` なデータセットのうち、窓（60 秒）が空いているものの `embedding_queued_at` を立て、同じ
   トランザクションで `embed-package` を 65 秒の遅延つきで積む。

**`summarize-all`** `{ refresh }` — 抄録の一括生成を始める。

1. 抄録が無効なサイトでは何もしない。
2. `active` で公開中のデータセットを id 順に読み、1 件ずつ `summarize-package` を積む（対象を含むかは見ない）。

**`reindex-metadata`** `{ includeContent }` — 検索索引のデータセット文書とリソース文書を作り直す。

1. OpenSearch が無いサイトでは 1〜3 を飛ばす。
2. `active` なデータセットを 100 件ずつ、行・配下リソース・グループ・タグ・組織名を読んでデータセット文書と
   リソース文書を組み立て、bulk で上書きする。先に空にはしない（空の索引は §3 の 60 秒タイマーが「失われた」と
   読むため）。その後、DB に `active` な行が無い文書を消す。
3. `includeContent` なら、本文チャンクを全件消し、全リソースの `contentIndexed` を false にし、`active` と
   下書きのデータセットの全リソースに `resource-pipeline` を積む（保存済みのオブジェクトがあれば
   `rebuildOnly`）。
4. `embed-all-packages` を積む（OpenSearch の有無にかかわらず）。

**`reanalyse-search-index`** — 解析設定（kuromoji など）が変わった索引を作り直す（ADR-025）。

1. OpenSearch が無いサイトでは何もしない。
2. 解析設定が古ければ、新しい解析設定の索引へ文書をコピーして差し替える。本文チャンクは `_source` から
   運ぶので、ファイルは読まない。
3. 修復待ちの印が索引にあれば、`reindex-metadata` の 2 と同じ再構築を行い、リソースが無い本文チャンクを消す。
   コピー中に Index が終わったリソースは、本文チャンクを消して `contentIndexed` を false にし、
   `resource-pipeline(rebuildOnly)` を積む。
4. 修復済みの印を付ける。

### 移行（1 回限り）

**`backfill-resource-versions`** — 版を持たないリソースに v1 を付ける（ADR-043）。

1. 版を持たないリソースを読む。
2. 1 件ずつ（並行数に上限あり）claim を取る。取れなければ飛ばし、次の実行で拾う。
3. 行が変わっていないかを確かめ、配信中のオブジェクトを**全部読んで**ハッシュとサイズを測り、行と食い違えば
   直し、v1 を記録する。
4. 層 2 に入っていない版の `lake-ingest-version` をまとめて積む。

**`convert-set-aside-versions`** — 旧方式の巻き戻しが残した `superseded` の版を変換する（ADR-044 §4）。

1. `superseded` の版を持つリソースを読む。
2. 1 件ずつ claim を取る（取れなければ飛ばす）。配信中の内容を新しい版として発行し、`superseded` を
   `active` に戻す。
3. 層 2 に入っていない版の `lake-ingest-version` をまとめて積む。

**`record-preview-row-groups`** — 行グループの大きさを記録していないプレビューに記録する（ADR-055 §6）。

1. 未記録のプレビューを読み、DuckDB のセッションを 1 つ開く。
2. プレビューごとに Parquet のフッターだけを読み、行グループの行数を取る。オブジェクトが無ければ
   「測れない」と記録する。
3. 行グループを小さくすれば配信できるようになる表で、保存済みのオブジェクトがあれば、
   `resource-pipeline(rebuildOnly)` を積む。積めなければ記録しない（次の実行でもう一度候補になる）。
4. 行数を記録する。

## 3. 依存関係 — 誰が何を積むか

```
[API: 個別の操作]
  リソースの作成・更新・再処理、アップロード完了 ──→ resource-pipeline
  データセットの公開・復元 ─────────────────────→ resource-pipeline × 配下（＋ リソース文書は直接書く）
  巻き戻し / 主キー / 列設定の変更 ──────────────→ resource-pipeline(rebuildOnly)
  データセット・リソースのメタデータ編集 ────────→ embed-package（60 秒の窓）
  抄録の非表示 ─────────────────────────────────→ embed-package ＋ sync-resource-doc
  版の削除 / 組織の完全削除 ─────────────────────→ purge-resource-version / purge-organization

resource-pipeline
  ├ claim が取れない / 取得がレート制限 ──→ resource-pipeline（遅延つきで積み直す）
  ├ Lake が失敗 ─────────────────────────→ lake-ingest-version
  └ Summarize
      ├ 抄録を書いた ────────────────────→ embed-package ＋ sync-resource-doc
      └ 書かなかった（unchanged/skipped）─→ sync-resource-doc

lake-ingest-version ──→ 同じリソースの次の未取込版 / claim が取れなければ自分を積み直す
purge-resource-version ──→ resource-pipeline(rebuildOnly)（配信中の版を消したとき）

[全件ジョブ: 管理画面から]
  reindex-metadata{includeContent:false}   「検索インデックスの再構築」
      └──→ embed-all-packages
  reindex-metadata{includeContent:true}    「全リソースの再処理」
      ├ 本文を全件削除し、contentIndexed を全件 false に
      ├──→ resource-pipeline(rebuildOnly) × 全リソース
      └──→ embed-all-packages
  embed-all-packages        「埋め込みの再生成」 ──→ embed-package × 全データセット
  summarize-all{refresh}    「不足分を生成」「すべて作り直す」 ──→ summarize-package × 公開中の全データセット
      summarize-package ──→ 次の summarize-package（データセット内を 1 リソースずつ）
                         ├──→ sync-resource-doc（1 リソースごと）
                         └──→ 連鎖の終わりに embed-package
  reanalyse-search-index ──→ resource-pipeline(rebuildOnly)（コピー中に索引されたものだけ）
  backfill-resource-versions / convert-set-aside-versions ──→ lake-ingest-version（未取込のものだけ）
  record-preview-row-groups ──→ resource-pipeline(rebuildOnly)（行グループが大きすぎるものだけ）
  POST /admin/jobs/enqueue-all（画面からの呼び出し元なし）──→ resource-pipeline × 全リソース（再取得あり）

[cron / タイマー]
  5 分ごと（HEALTH_CHECK_CRON）──→ resource-pipeline（変化を検知したもの、定期の全取得）
  毎時 17 分 ──→ 取り残された purge-*（ジョブを失った purging の版・組織）
  毎時 37 分 ──→ lake-ingest-version（層 2 に入っていない版）
  毎時 47 分 ──→ sync-resource-doc（docSyncDueAt が立ったままの行、1 回 200 件まで）
  60 秒ごと ───→ reindex-metadata{includeContent:true}（索引が空で DB に公開中のデータセットがあるとき）
```

## 4. 書き込み先ごとの依存

| 書き込み先         | 材料                                                                             | 他のリソースに依存するか |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------ |
| 本文チャンク       | そのリソースのファイル（パイプラインの Index が書く）                            | しない                   |
| リソース文書       | そのリソースの行。抄録を含む（`buildResourceDoc`）                               | しない                   |
| リソースの埋め込み | データセットの title・tags ＋ そのリソースの section / name / description / 抄録 | しない                   |
| データセット文書   | データセットの行 ＋ 配下リソースの `format`（`formats` ファセット）              | `format` だけ            |

- パイプラインの Index が書くのは本文チャンクだけで、リソース文書には触れない。
  リソース文書を書くのは API の編集、公開・復元、`sync-resource-doc`、索引の再構築である。
- データセット文書が集める `format` は API の編集で書かれる宣言上の形式で、パイプラインは書かない。
  API はリソースの作成・更新・削除のたびにデータセット文書を同期する。
- 依存が他へ広がるのは「データセットの title・tags が変わると、配下の全リソースの埋め込みが古くなる」
  の一方向だけである。**全リソースが終わるのを待ってから作るもの**は無い。

## 5. 全件と個別

全件ジョブは 2 種類ある。

**条件で絞る全件** — 述語が「まだ残っている仕事」をそのまま表すので、何度押しても対象外には何もしない。

| 全件                                 | 条件                                  | 個別の側              |
| ------------------------------------ | ------------------------------------- | --------------------- |
| 毎時の層 2 取込                      | 層 2 に入っていない版                 | `lake-ingest-version` |
| 毎時の purge 回収                    | ジョブを失った `purging`              | `purge-*`             |
| 毎時のリソース文書                   | `docSyncDueAt` の印                   | `sync-resource-doc`   |
| `reanalyse-search-index`             | 解析設定が古い索引（`analysisStale`） | —                     |
| 移行系（版の付与・行グループの記録） | 未移行の行                            | —                     |

**無条件の全件** — 対象を絞らずに全データセット・全リソースへ展開する。

| 全件                               | 何のためにあるか                                                                                           | 個別の側                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `embed-all-packages`               | 埋め込みを後から有効にした・モデルを変えた。個別の積み損ね（印を残さない）の回収も兼ねる                   | `embed-package`（ハッシュ一致で生成しない） |
| `summarize-all`                    | 抄録を後から有効にした・プロンプトを変えた                                                                 | パイプラインの Summarize                    |
| `reindex-metadata{includeContent}` | 抽出・解釈のコードが変わった・索引を失った。派生物がどのコードで作られたかの記録が無いので、条件で絞れない | `resource-pipeline`                         |
| `POST /admin/jobs/enqueue-all`     | 全件の再取得                                                                                               | `resource-pipeline`                         |

`rebuildOnly` の run は「同じバイト列なら Interpret と Index を飛ばす」判定（`derivativesReused`）を
通らない。作り直すよう頼まれた run だからである。通常の run はこの判定で飛ばす。

## 6. 排他 — claim を取るジョブと取らないジョブ

排他は 3 層ある。

1. **ジョブのリース**（`job.locked_until`）— すべてのジョブ。同じ行を 2 台が処理しない。
2. **リソースの実行 claim**（`resource_pipeline.claim_owner`、`docs/pipeline.md` §2）— 一部のジョブ。
3. **ジョブごとの仕組み** — 状態遷移、積む時点の窓、CAS の印。

| ジョブ                                                      | リソースの claim                         | 代わりに / 加えて                              |
| ----------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `resource-pipeline`                                         | 取る（`run`）                            | 取れなければ遅延つきで積み直す                 |
| `summarize-package`                                         | 取る（1 リソースずつ）                   | 取れなければ同じ位置で積み直す                 |
| `lake-ingest-version`                                       | 取る（`job`）                            | 版の `lake_ingest_queued_at` のリース          |
| `backfill-resource-versions` / `convert-set-aside-versions` | 取る（取れなければそのリソースを飛ばす） | 冪等。再実行で拾う                             |
| `purge-resource-version`                                    | 取る（取れなければ Conflict）            | 版の状態 `purging`                             |
| `purge-organization`                                        | 取る（配下の全リソース）                 | 組織の状態 `purging`（ADR-028）                |
| `sync-resource-doc`                                         | 取らない                                 | `docSyncDueAt` の CAS                          |
| `embed-package`                                             | 取らない                                 | 積む時点の窓（`embeddingQueuedAt`、60 秒）     |
| `reindex-metadata` / `reanalyse-search-index`               | 取らない                                 | reanalyse はコピー中に書かれたものを後から直す |
| `record-preview-row-groups`                                 | 取らない                                 | フッターを読むだけ。再解釈は run に任せる      |
| `embed-all-packages` / `summarize-all`                      | 取らない                                 | 積むだけ                                       |

基準は一貫している。**リソースの派生物（ストレージのオブジェクト、版、Parquet、層 2）に書くジョブは
claim を取る。** 行や索引を「行の今の状態」に合わせ直すだけのジョブは取らない。

claim を取るジョブは、同じリソースに当たっても積み直されるだけなので、並行して走らせても正しい。
取らないジョブは、同時に 2 本走っても正しいかを、それぞれの仕組みで個別に確かめる必要がある。

## 7. ジョブを足す・変えるときの点検

- **誰が結果を待っているか。** 人が画面の前で待つ操作から積むのか、一括処理から展開するのか。
  今は取り出し順に反映されないが、どちらかを決めておく。
- **何を積むか。** §2 に手順を、§3 の図に矢印を足す。積む先がさらに積むものまで追う。
- **全件なら、条件で絞れるか。** 画面の件数と同じ述語を使えるなら、それで絞る。
- **積む前に、仕事があるかを判断できるか。** 材料が実際に変わった書き込みでだけ積む（印を立てる）。
  判断できないなら、結果が変わらないときに何も書かずに済むか。
- **claim を取るか。** 取らないなら、同時に 2 本走っても正しい理由を書く。

## 8. 用語

| 語     | 意味                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 印     | 「この行について、まだ済んでいない仕事がある」と行に書いておく nullable な時刻の列。値があれば「立っている」、null なら「立っていない」。例: `resource.doc_sync_due_at`（検索文書が古い） |
| 窓     | 同じ対象に対して一定時間は 2 本目を積まない仕組み。例: `package.embedding_queued_at`（60 秒）                                                                                             |
| 空振り | 積まれたジョブが、何も変わっていないことを確かめるだけで終わること                                                                                                                        |
| claim  | リソースの実行 claim（`docs/pipeline.md` §2）。1 リソースに書き手は 1 人                                                                                                                  |
