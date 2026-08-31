# Changelog

All notable changes to KUKAN are documented in this file (English / 日本語).
This project adheres to [Semantic Versioning](https://semver.org/).

The #nnn references are internal change-tracking numbers, not issues or pull requests on this repository.
本文中の #nnn は開発時の内部管理番号であり、このリポジトリの issue・PR 番号ではありません。

## [0.20.0] - 2026-08-31

**Highlights**

- The table preview is now a single table — the "analysis mode" toggle is gone. Browsing stays as light as before, and the first sort, filter or search starts the analysis engine in the background: the action you took is applied automatically the moment the engine is ready.
- Public pages now hold up on phones: at 320–390 px widths the layout no longer scrolls horizontally, dataset titles keep their width, and the home statistics cards read as a 2×2 grid — guarded by a new responsive e2e test.

**Features**

- feat(web): modeless table preview with range-read analysis (#511) — the DuckDB-WASM "analysis mode" toggle is removed (ADR-048, replacing ADR-016). The initial table renders from lightweight range reads with no engine loaded; sorting, filtering or searching boots DuckDB-WASM behind the scenes without blocking the page, and if the engine or a query fails the table falls back to the plain view with a visible notice and retries on the next interaction. Under the hood, the `/preview` endpoint now implements RFC 9110 Range semantics faithfully — open-ended ranges stream to end of file instead of being truncated, suffix ranges are supported, HEAD always answers with the full length, responses are never falsely labeled partial, and malformed huge ranges are rejected — groundwork for streaming even larger previews in a later release.

**Bug Fixes**

- fix(web): prevent horizontal overflow on mobile widths (#512) — at phone widths (320–390 px) the dataset list no longer scrolls sideways, long dataset slugs wrap instead of stretching the page, dataset card titles are no longer squeezed to one character per line by the date block, the home statistics grid switches to two columns, and list headers and sort controls wrap. A new e2e test asserts no horizontal overflow on the public pages at 320 px and 390 px.

---

**ハイライト**

- テーブルプレビューが一枚の表になりました —「解析モード」トグルは廃止です。閲覧はこれまでどおり軽く、最初のソート・フィルター・検索の操作で解析エンジンが裏で起動し、準備が整った瞬間にその操作が自動で適用されます。
- 公開ページがスマートフォンでも崩れなくなりました。320〜390px 幅で横スクロールが発生せず、データセット名の潰れやトップの統計カードの縦積みも解消しています。回帰を防ぐ responsive e2e テストも追加しました。

**機能**

- feat(web): モードレステーブルプレビュー(Range 読み + 暗黙の解析起動)(#511) — DuckDB-WASM の「解析モード」トグルを廃止しました(ADR-048、ADR-016 を置換)。初期表示はエンジンなしの軽量な Range 読みで描画し、ソート・フィルター・検索の操作で DuckDB-WASM がページを塞がずに裏で起動します。エンジンやクエリが失敗した場合は通知を残して素の表示に降格し、次の操作で再起動を試みます。あわせて `/preview` エンドポイントの Range 応答を RFC 9110 に忠実に修正しました — 終端なし Range の 1 MB 切り詰めを廃止して EOF まで応答、suffix 形式に対応、HEAD は常に全長を返し、部分応答の偽装をなくし、壊れた巨大 Range は拒否します。将来のより大きなプレビューの配信に向けた下地です

**バグ修正**

- fix(web): スマホ幅での横スクロールを解消 (#512) — スマートフォン幅(320〜390px)でデータセット一覧が横にスクロールする問題を修正しました。長いデータセット slug は折り返し、日時ブロックがカードタイトルを 1 文字幅まで潰す問題も解消し、トップの統計グリッドは 2 カラムに切り替わり、一覧ヘッダーとソートボタンは折り返すようになりました。公開ページで横スクロールが発生しないことを 320px / 390px で検証する e2e テストを追加しています

## [0.19.1] - 2026-08-28

**Highlights**

- The landing page now leads straight to the live demo: a "View the Live Demo" button in the hero, and a hero visual built from real demo screens — a CSV resource page with its table preview and a GeoJSON resource page with its map preview, framed as browser windows.

**Features**

- feat(site): showcase the live demo on the landing page (#507) — the hero buttons regroup into two rows with a live-demo link, every external link opens in a new tab and carries an external-link icon, and two browser-framed screenshots of the demo site cascade below the hero. The screenshots are captured from the Japanese UI and shipped as lazy-loaded WebP with fixed dimensions, so the page stays light and layout-stable.

---

**ハイライト**

- LP からデモサイトへ直接たどり着けるようになりました。ヒーローに「デモサイトを見る」ボタンを追加し、デモの実画面 — CSV リソースページのテーブルプレビューと GeoJSON リソースページの地図プレビュー — をブラウザウィンドウ風にあしらったビジュアルを掲載しています。

**機能**

- feat(site): LP でライブデモを紹介 (#507) — ヒーローのボタンを 2 段組に再構成してデモへのリンクを追加し、外部リンクはすべて別タブで開くようにして外部リンクアイコンを付けました。ヒーロー直下にはデモサイトの実画面 2 枚をブラウザフレーム付きで重ねて配置しています。スクリーンショットは日本語 UI で撮影し、遅延読み込みの WebP + サイズ固定で軽さとレイアウト安定性を保っています

## [0.19.0] - 2026-08-28

**Highlights**

- Table preview and row-level versioning now cover every CSV/TSV the catalog accepts: the interpretation cap rose from 50 MB to 100 MB, matching the upload and URL-fetch limits, so there is no longer a size band where a file can be registered but gets no table preview, no row-level diff and no Data API.

**Features**

- feat(pipeline): raise the parquet interpretation cap to the upload limit (#505) — CSV/TSV files between 50 MB and 100 MB now get a table preview, DuckLake row-level versioning and diffs, and Data API queries. Measured before raising: a 100 MB CSV interprets in about 2 seconds and every DuckLake operation on it stays under half a second at the production memory limits. No migration is needed — the hourly sweep picks up already-registered files in that band by itself after the upgrade.
- feat(web): add brand-controlled noindex robots meta tag (#504) — a brand can set `noindex: true` in its brand config to emit a site-wide `noindex, nofollow` robots meta tag, for demo or staging deployments that should stay out of search engines. Crawling itself stays allowed, so the meta tag remains visible to crawlers.

---

**ハイライト**

- テーブルプレビューと行レベルの版管理が、カタログに登録できるすべての CSV/TSV をカバーするようになりました。解釈の上限を 50 MB から 100 MB に引き上げてアップロード・外部 URL 取得の上限と揃えたため、「登録はできるのにテーブルプレビューも行レベル差分も Data API も使えない」サイズ帯がなくなりました。

**機能**

- feat(pipeline): Parquet 解釈の上限をアップロード上限まで引き上げ (#505) — 50〜100 MB の CSV/TSV でもテーブルプレビュー・DuckLake の行レベル版管理と差分・Data API クエリが使えるようになりました。引き上げ前に計測済みで、100 MB の CSV の解釈は約 2 秒、DuckLake の各操作は本番のメモリ制限下で 0.5 秒未満です。マイグレーションは不要です — アップグレード後、毎時の sweep が該当サイズ帯の登録済みファイルを自動で取り込み直します
- feat(web): ブランド設定によるサイト全体の noindex 指定 (#504) — ブランド設定で `noindex: true` を指定すると、サイト全体に `noindex, nofollow` の robots メタタグを出力します。検索エンジンに載せたくないデモ・ステージング環境向けの機能です。クロール自体は許可したままにするため、メタタグはクローラーから見える状態を保ちます

## [0.18.0] - 2026-08-27

**Highlights**

- Version history is now visible to everyone: the public resource page lists past versions with per-version download, so visitors can see how a resource has evolved without a dashboard account.
- Queryable resources get a "Data API" panel that teaches the query API in place — copyable endpoint URLs, curl / JavaScript examples, and an editable SQL example you can run right in the dialog.

**Features**

- feat(web): show version history on the public resource page (#500) — a collapsible section lists versions (latest 10 with "show all") with creation date, size and per-version download, and shows deleted versions as tombstones; the version-list endpoints now allow short anonymous CDN caching
- feat(web): add Data API panel with runnable SQL examples (#496) — endpoint URLs and curl / JavaScript snippets carry the real resource id, and the SQL example (pre-filled with the resource's actual columns) runs against the server-side query sandbox with results in a table; syntax highlighting is lazy-loaded so the initial bundle size is unchanged

**Bug Fixes**

- fix(api): align queryable flag with actual query availability (#498) — `queryable` now means a query will actually work: resources whose interpretation produced no table, whose preview was removed, or whose preview describes replaced content no longer claim to be queryable (REST and MCP), and querying such a stale preview is rejected instead of silently returning old data
- fix(lake): refresh expired S3 credentials in cached DuckDB instances (#501) — on AWS the DuckLake S3 credentials were resolved once per process and expired a few hours later, stalling row-level diff loading until a restart; the credentials now refresh automatically and an expired session is rebuilt

---

**ハイライト**

- 版履歴がすべての閲覧者に公開されました。公開リソースページに過去の版の一覧と版指定ダウンロードが表示され、ダッシュボードのアカウントがなくてもリソースの更新経緯を確認できます。
- クエリ可能なリソースに「Data API」パネルが付きました。エンドポイント URL のコピー、curl / JavaScript の使用例、そしてその場で編集・実行できる SQL 例で、クエリ API の使い方をページ上で学べます。

**機能**

- feat(web): 公開リソースページに版履歴を表示 (#500) — 折りたたみセクションに版の一覧（最新 10 件 + 「すべての版を表示」）を作成日時・サイズ・版指定ダウンロード付きで表示し、削除済みの版は墓標として表示します。版一覧 API は匿名アクセスに限り短時間の CDN キャッシュを許可するようになりました
- feat(web): 実行可能な SQL 例付きの Data API パネルを追加 (#496) — エンドポイント URL と curl / JavaScript スニペットには実際のリソース ID が入り、実際の列名を埋め込んだ SQL 例はサーバーサイドのクエリサンドボックスでその場で実行して結果をテーブル表示できます。シンタックスハイライトは遅延ロードのため初期バンドルサイズは変わりません

**バグ修正**

- fix(api): queryable フラグを実際のクエリ可否と一致させる (#498) — `queryable` が「クエリが実際に動くこと」を意味するようになりました。解釈がテーブルを生まなかったリソース、プレビューが削除されたリソース、内容差し替え前のプレビューが残っているリソースはクエリ可能と申告しなくなり（REST / MCP 共通）、古いプレビューへのクエリは旧内容を黙って返す代わりに拒否されます
- fix(lake): キャッシュ済み DuckDB インスタンスの期限切れ S3 認証情報を更新 (#501) — AWS では DuckLake の S3 認証情報がプロセスごとに一度だけ解決され、数時間後に失効すると再起動まで行レベル差分の取込が止まっていました。認証情報は自動更新され、失効したセッションは再構築されます

---

## [0.17.1] - 2026-08-24

Infrastructure-only fix for AWS pipeline deploys of v0.17.0. No change to application behaviour.

**Bug Fixes**

- fix(infra): use MEDIUM compute for pipeline asset publishing — the default SMALL (3 GB) CodeBuild instance ran out of memory during the web image's type check (the heavier type inference in better-auth 1.7 pushed it over the limit) and the build failed with no diagnostics (#494)

---

v0.17.0 の AWS パイプラインデプロイ向けのインフラ修正のみです。アプリケーションの動作に変更はありません。

**バグ修正**

- fix(infra): パイプラインのアセット公開ビルドを MEDIUM に引き上げ — デフォルトの SMALL(3GB)CodeBuild インスタンスでは web イメージの型チェック中にメモリが枯渇し(better-auth 1.7 の重い型推論が限界を超えた)、診断なしでビルドが失敗していました (#494)

## [0.17.0] - 2026-08-24

**Highlights**

- Better Auth is upgraded from 1.6 to 1.7. Version 1.7 changes how accounts are identified: instead of the provider-configuration name, each account is now keyed by the identity that actually vouched for it — `(issuer, accountId)` — enforced by a database unique constraint. Existing password accounts are migrated automatically; no user action is needed and sessions stay valid.
- The migration is designed for zero-downtime rolling deploys: the schema stays compatible with 1.6 processes running alongside it, so sign-in keeps working while old and new instances overlap, and an automatic rollback leaves a working system. The leftover compatibility shims will be removed in a later release.

**Features**

- feat(api): upgrade better-auth to 1.7 with account issuer migration (#490)

**Tests / CI**

- perf(test): run web unit tests in the vmThreads pool, cutting unit-test CI time roughly in half (#488)
- test(lake): raise hookTimeout to match testTimeout (#489)
- ci: exclude `.next/cache` from turbo build outputs to keep CI caches small (#487)
- ci: redeploy the documentation site when the release version or date changes (#486)
- build(deps): update the pinned CodeQL action to 4.37.8 in the analysis workflows (#492)

---

**ハイライト**

- Better Auth を 1.6 から 1.7 に更新しました。1.7 ではアカウントの同定方法が変わり、プロバイダー設定名ではなく「そのアカウントの身元を実際に保証した発行者」を使う `(issuer, accountId)` の組がデータベースの一意制約として強制されます。既存のパスワードアカウントは自動で移行され、利用者の操作は不要です。セッションも維持されます。
- マイグレーションは無停止のローリングデプロイを前提に設計しています。移行後のスキーマは 1.6 のプロセスとも互換なので、新旧インスタンスが併走する間もサインインは動き続け、自動ロールバックが起きても動作する状態が保たれます。互換のために残した措置は後続リリースで削除します。

**機能**

- feat(api): better-auth 1.7 への更新と account issuer マイグレーション (#490)

**テスト / CI**

- perf(test): web ユニットテストを vmThreads プールで実行し、ユニットテストの CI 時間を約半分に短縮 (#488)
- test(lake): hookTimeout を testTimeout に合わせて引き上げ (#489)
- ci: turbo のビルド出力から `.next/cache` を除外し、CI キャッシュの肥大を解消 (#487)
- ci: リリースバージョン・日付の変更時にドキュメントサイトを再デプロイ (#486)
- build(deps): 解析ワークフローの CodeQL action ピンを 4.37.8 に更新 (#492)

## [0.16.1] - 2026-08-24

Fixes a deployment blocker: web container images built from v0.15.1 and v0.16.0 fail to start. Use this release for any deploy.

**Bug Fixes**

- fix(web): update Next.js to 16.3.2 so the standalone server boots — 16.3.1's standalone output missed `@swc/helpers`' esm files and the server crashed on start with `MODULE_NOT_FOUND` (#484)

**CI**

- ci: boot-smoke the Next standalone output in web-build, so a server that builds but cannot start fails the pull request instead of the deploy (#484)

---

デプロイを妨げる問題の修正です: v0.15.1・v0.16.0 からビルドした web コンテナイメージは起動に失敗します。デプロイにはこのリリースを使ってください。

**バグ修正**

- fix(web): Next.js を 16.3.2 に更新し standalone サーバーが起動するように修正 — 16.3.1 の standalone 出力は `@swc/helpers` の esm ファイルを含まず、起動時に `MODULE_NOT_FOUND` でクラッシュしていました (#484)

**CI**

- ci: web-build で standalone 出力を実際に起動するスモークを追加 — 「ビルドは通るが起動できない」欠陥をデプロイでなく PR の段階で検出します (#484)

## [0.16.0] - 2026-08-23

**Highlights**

- The raw-text preview now has a line-number gutter. For CSV/TSV it numbers parsed records under the dialect the file was actually read with — a record spanning quoted newlines gets one number — so the "rows not in the table (at line N)" note finally points at a line you can find in the text. The worker records the sniffed dialect alongside the dropped-line numbers to make that exact.
- Primary keys are now visible to readers, not just to editors: `GET /resources/{id}/schema` and the MCP `get_resource_schema` tool report the settled key, and the preview table, the analysis mode, and the fields list mark its columns in the same colour the key picker uses.
- Numeric columns right-align with tabular figures and decimal columns line up on the decimal point in both preview modes, and DATE/TIMESTAMP values now render identically in the plain table and the analysis mode.

**Features**

- feat: line numbers, key marking, and numeric alignment in resource previews (#480)

---

**ハイライト**

- テキストプレビューに行番号欄が付きました。CSV/TSV では、ファイルが実際に読まれた方言のもとでパース済みレコード単位に番号を振ります(引用符内改行をまたぐレコードは 1 つの番号)。これにより「ファイルにあって表に含まれていない行数(N 行目)」の注記が、テキスト上で実際に見つけられる行を指すようになりました。正確を期すため、worker は落ちた行番号の横にスニフした方言を記録します。
- 主キーが閲覧者にも見えるようになりました。`GET /resources/{id}/schema` と MCP の `get_resource_schema` が確定済みの主キーを返し、プレビューテーブル・解析モード・項目一覧が主キー列を管理画面のピッカーと同じ色で表示します。
- 両プレビューモードで整数・数値列が等幅数字の右揃えになり、数値列は小数点位置が揃います。日付・日時の表示もテーブル表示と解析モードで統一されました。

**機能**

- feat: リソースプレビューの行番号・主キー表示・数値桁揃え (#480)

## [0.15.1] - 2026-08-23

Dependency updates and faster CI. No change to application behaviour.

**Dependencies**

- 33 minor and patch bumps across the workspace (#475), including pg 8.23, hono 4.13.3, next 16.3.1, papaparse 5.6, and the AWS SDK / CDK line. better-auth stays on 1.6.x (1.6.30): 1.7 is a breaking release and is held back for a migration of its own (#472).
- aws-cdk-lib 2.266 propagates tags to ALB listeners, so the infrastructure golden templates were updated to match. The next deploy shows tag-only additions on listeners — an in-place, non-disruptive change (#475).

**CI**

- Pull request CI got faster: the database-integration job skips changes that touch only docs, the doc site, or infrastructure code; the Next.js build check runs beside the database suites instead of in front of them; and a superseded push cancels the run it obsoleted (#477).

---

依存関係の更新と CI の高速化のみで、アプリケーションの動作に変更はありません。

**依存関係**

- ワークスペース全体で 33 件の minor / patch 更新（#475）。pg 8.23、hono 4.13.3、next 16.3.1、papaparse 5.6、AWS SDK / CDK 系など。better-auth は 1.6 系（1.6.30）に留めています — 1.7 は破壊的変更を含むため、専用のマイグレーションとして別途対応します（#472）。
- aws-cdk-lib 2.266 が ALB リスナーへタグを伝播するようになったため、インフラのゴールデンテンプレートを追随させました。次回デプロイではリスナーへのタグ追加のみの差分が出ます — 置換を伴わない無停止の変更です（#475）。

**CI**

- PR の CI を高速化しました: DB 統合テストのジョブはドキュメント・ドキュメントサイト・インフラコードのみの変更をスキップし、Next.js のビルドチェックは DB テストの手前ではなく並列に実行され、古くなった push の実行は新しい push がキャンセルします（#477）。

## [0.15.0] - 2026-08-23

**Highlights**

- **Row-level diffs can now track changed rows.** Declare a primary key on a resource — the column, or combination of columns, that identifies a row — and diffs between versions report "N rows changed" with before → after samples, instead of showing every edit as one removal plus one addition. The key is checked before it is applied (present in the content, no empty values, unique across rows), each version records the key it was read under, and content that does not satisfy the key is left out of row-level diffs with the reason shown in the version list (#439, #440, #443, #444, #445, #446, #448).
- **Reverting now issues a new version instead of setting history aside.** "Stop and revert" publishes the restored content forward as a new version — the history gains a "Re-published vN" row, and no version is removed or hidden. Resources that an old-style revert had left with set-aside versions are converted by a new one-time item on the site administrator's dashboard, so the latest-version label agrees with what is being served (#432, #437).
- **CSV interpretation is steadier around ragged rows and footnotes.** A CSV with an occasional ragged row is still read as a table, and the interpretation says which lines were dropped. Data rows are no longer deleted just because their first cell begins like a footnote, padded notes are judged by the same rule in both passes, and the preview shows one footer wherever the table is read (#450, #455, #456, #457).
- **Private datasets no longer leave traces on public surfaces.** Public list counts, tag and format lists, and deleted-dataset counts no longer reveal that a private dataset exists (#461, #466).
- **Form fields no longer turn gray under OS dark mode.** With the operating system set to dark, inputs rendered with a gray background that made them look disabled. The dark-theme styles now stay off until KUKAN actually ships a dark theme (#467).

**Features**

- feat(web): let an admin choose the columns a resource's rows are identified by (#448)
- feat(api): say what each version was read under, and why one was refused (#446)
- feat(api): answer whether a key would work before it is applied (#445)
- feat(lake): match rows by the key both versions were loaded under (#444)
- feat(lake): apply a keyed version row by row, or record why it cannot be (#443)
- feat(api): let an editor settle the key rows are identified by (#440)
- feat(api): freeze the key a version is read under (#439)
- feat(api): make a revert publish the version it goes back to (#432)

**Changes**

- The new-dataset page no longer asks for a source URL (#462)

**Bug Fixes**

- fix(api): hide private-dataset traces from public tag, format, and deleted-count surfaces (#466)
- fix(api): hide private datasets from public list counts (#461)
- fix(web): one footer under the table, whichever way it is being read (#457)
- fix(worker): judge a padded note by the same rule, and count what both passes took (#456)
- fix(worker): stop deleting rows because their first cell begins like a footer (#455)
- fix(worker): read a CSV with a ragged row as a table, and say which line was dropped (#450)
- fix(api): convert the versions an old-style revert set aside (#437)
- fix(web): scope dark variant to explicit class so OS dark mode does not gray out inputs (#467)

**Documentation**

- The data admin guide documents the primary key control, the six reasons a diff can be unavailable, and the new revert behaviour; wording about deleting a version now claims exactly what a deletion guarantees (#468).
- The open ii-b design decisions were settled in the implementation spec before the work began (#431).

---

**ハイライト**

- **行レベル差分が「変更された行」を追跡できるようになりました。** リソースに主キー — 行を同定する列、または列の組み合わせ — を指定すると、版どうしの差分が「変更 N 行」と変更前 → 変更後の抜粋を表示します。指定が無い場合、1 行の書き換えはこれまでどおり「追加 1 行 + 削除 1 行」として現れます。キーは適用前に検査され（内容にその列があること・空の値が無いこと・行ごとに値が重複しないこと）、各版は自分が読まれたときのキーを記録し、キーを満たさない内容は理由つきで行レベル差分の対象外になります（#439、#440、#443、#444、#445、#446、#448）。
- **巻き戻しが、履歴を脇へ避ける代わりに新しい版を発行するようになりました。** 「中止して巻き戻す」は戻す内容を新しい版として前へ発行します — 履歴には「vN を再公開」の行が増え、どの版も消えたり隠れたりしません。旧方式の巻き戻しが脇へ避けた版が残っているリソースは、サイト管理者ダッシュボードに追加された一度きりの変換で、最新バージョンの表示と配信中の内容が一致する状態になります（#432、#437）。
- **CSV の解釈が、列数の乱れと脚注に対して安定しました。** 一部の行の列数が揃っていない CSV も表として読み、どの行を落としたかを解釈が報告します。先頭セルが脚注のように始まるだけでデータ行が消されることはなくなり、パディングされた注記は両方のパスで同じ規則で判定され、プレビューの脚注はどの読み方でも 1 つだけ表示されます（#450、#455、#456、#457）。
- **非公開データセットが公開側に痕跡を残さなくなりました。** 公開の一覧件数、タグ・フォーマットの一覧、削除済み件数から、非公開データセットの存在が推測できなくなりました（#461、#466）。
- **OS のダークモードで入力欄がグレーになる問題を修正しました。** OS がダークモード設定のとき、入力欄の背景がグレーになり無効状態と見分けがつきませんでした。KUKAN が実際にダークテーマを提供するまで、ダークテーマ用のスタイルは発火しなくなりました（#467）。

**機能**

- feat(web): リソースの行を同定する列を管理者が選べるようにする（#448）
- feat(api): 各版が何のキーで読まれたか・なぜ拒否されたかを返す（#446）
- feat(api): キーが機能するかを適用前に答える（#445）
- feat(lake): 両方の版が読まれたキーで行を突き合わせる（#444）
- feat(lake): キー付きの版を行単位で適用し、できない理由を記録する（#443）
- feat(api): 行を同定するキーを編集者が確定できるようにする（#440）
- feat(api): 版が読まれたキーを版に凍結する（#439）
- feat(api): 巻き戻しを「戻り先の内容の再発行」にする（#432）

**変更**

- 新規データセット作成ページからソース URL 欄を削除しました（#462）

**バグ修正**

- fix(api): 非公開データセットの痕跡を公開のタグ・フォーマット・削除済み件数から隠す（#466）
- fix(api): 非公開データセットを公開の一覧件数から隠す（#461）
- fix(web): テーブルの脚注をどの読み方でも 1 つにする（#457）
- fix(worker): パディングされた注記を同じ規則で判定し、両パスの所要を数える（#456）
- fix(worker): 先頭セルが脚注のように始まる行を削除しない（#455）
- fix(worker): 列数の乱れた CSV を表として読み、落とした行を報告する（#450）
- fix(api): 旧方式の巻き戻しが脇へ避けた版を変換する（#437）
- fix(web): dark バリアントを明示クラスに限定し OS ダークモードで入力欄がグレーになるのを防ぐ（#467）

**ドキュメント**

- データ管理者ガイドに主キーの指定、差分を取得できない 6 つの理由、新しい巻き戻しの挙動を記載しました。版の削除についての文言は、削除が保証する範囲だけを主張するよう改めました（#468）。
- ii-b の未確定だった設計判断を、実装前に実装仕様書で確定しました（#431）。

## [0.14.0] - 2026-08-17

**Breaking Changes**

- A version's API response no longer carries `purgeReason`. The reason an administrator types when purging a version was readable by anyone who could read the resource — anonymously, on a public dataset — and for a takedown that text can describe the very content being removed. There is nothing to migrate unless a client was reading the field; who purged what, when and why is still recorded in the audit log (#429).

**Highlights**

- **A purge no longer destroys a resource's row history.** Purging the newest version could drop the resource's row-level table outright: whenever the version serving underneath had never been ingested — too large for the row store, or not tabular — the purge read "nothing to fall back to" and dropped the whole table, including the versions that did have rows. Nothing put it back afterwards. Purges from this release step the table back onto the newest version that actually holds rows, and drop it only when no version does (#427).
- **The purge confirmation now says what will happen.** Instead of describing every branch conditionally, it names the case: whether this is the version currently being served, which version serving falls back to afterwards, or that nothing being served and nothing derived from it changes. Both answers come from the server, because neither can be worked out from the version list — after a revert, the version being served is not the newest one, and while a purge is in flight it is not the newest active one either (#428).
- **A revert now takes the row history with it.** Reverting a resource's content left the row-level table holding exactly the rows the revert had retracted, and the next update built on top of them. A revert now moves the table back as well, and an ingest begins from the version it builds on rather than from whatever the table happened to be holding (#422, #423).
- **What a purge claims is what a purge does.** The confirmation no longer promises that row data is erased. Row-level storage keeps history for every resource in one shared series, so a purge can make a version unobtainable without being able to free its bytes — the wording now says that plainly, and says what is guaranteed instead (#424).

**Features**

- feat(api): tell the purge screen which version is live (#428)

**Bug Fixes**

- fix(api): stand a purged table on layer 2's own version (#427)
- fix(api): stop handing a purge reason to everyone who can read the resource (#429)
- fix(api): follow a revert through into the DuckLake table (#422)
- fix(api): stand the lake table on its base before an ingest (#423)
- fix(web): correct what a version purge claims (#424)

**Documentation**

- The administrator guide said the version history keeps the reason you type when purging. It does not, and the guide now says so — the field is a note for the operators, not a place to restate what had to be removed (#429).
- The implementation specifications are split into `docs/specs/jp/` and `docs/specs/en/`, the way the ADRs already were. Japanese remains authoritative (#426).

---

**破壊的変更**

- 版の API 応答から `purgeReason` を削除しました。版をパージするときに管理者が入力する理由は、そのリソースを読める人すべて — 公開データセットなら匿名でも — が読める状態でした。削除要請への対応では、その文面が消すはずだった内容そのものを記述していることがありえます。このフィールドを読んでいたクライアントがなければ移行は不要です。誰が何をいつどんな理由でパージしたかは、引き続き監査ログに記録されます（#429）。

**ハイライト**

- **パージがリソースの行履歴を壊さなくなりました。** 最新版をパージすると、リソースの行レベルテーブルごと落ちることがありました。その下で配信されていた版が行ストアに入っていない場合 — サイズ超過、または表形式でない場合 — パージが「戻り先が無い」と読み、行を持っていた過去の版まで含めてテーブル全体を落としていました。その後それを戻す仕組みもありませんでした。本リリース以降のパージは、実際に行を持っている最新の版までテーブルを戻し、そういう版が1つも無いときにだけ落とします（#427）。
- **パージ確認画面が「何が起きるか」を明示します。** すべての分岐を条件付きで並べるのをやめ、場合を名指しします — この版が現在配信されている内容か、配信がどの版へ戻るか、あるいは配信中の内容とその派生物は何も変わらないか。どちらの答えもサーバーが返します。版一覧からは決められないためです（巻き戻しの後は配信中の版が最新版ではなく、パージ実行中は最新の有効な版でもありません）（#428）。
- **巻き戻しが行履歴も一緒に戻します。** リソースの内容を巻き戻しても、行レベルテーブルは撤回したはずの行を保持したままで、次の更新はその上に積まれていました。巻き戻しはテーブルも戻すようになり、取り込みは「テーブルにたまたま入っていた内容」ではなく「その版が積む土台」から始まります（#422、#423）。
- **パージの説明が実際の動作と一致しました。** 確認画面は「行データを消去する」とは言わなくなりました。行レベルのストレージは全リソースの履歴を1つの系列で保持するため、パージは版を取得できなくすることはできても、そのバイト列を解放できるとは限りません。文面はその事実と、代わりに何を保証するのかを述べるようになりました（#424）。

**機能**

- feat(api): パージ画面へ「どの版が配信中か」を返す（#428）

**バグ修正**

- fix(api): パージ後のテーブルを層 2 自身の戻り先に立てる（#427）
- fix(api): リソースを読める全員にパージ理由を渡すのをやめる（#429）
- fix(api): 巻き戻しを DuckLake テーブルまで追随させる（#422）
- fix(api): 取り込みの前にテーブルを土台へ立てる（#423）
- fix(web): 版のパージが主張する内容を訂正（#424）

**ドキュメント**

- 管理者ガイドに「版履歴にはパージ理由が残る」と書かれていましたが、実際には残りません。ガイドを訂正しました — 理由欄は運用者向けのメモであって、消すべき内容を書き写す場所ではありません（#429）。
- 実装仕様書を ADR と同じように `docs/specs/jp/` と `docs/specs/en/` へ分割しました。日本語が正本です（#426）。

## [0.13.1] - 2026-08-12

Documentation only. No change to the application.

**Documentation**

- The password change added in 0.13.0 is now documented. The user guide says where the form is and what a password has to satisfy — 15 characters and a zxcvbn score of 3 out of 4, and that length alone will not carry a password built out of your own email address, username or display name. The system administrator guide gains `PASSWORD_MIN_SCORE`, what it applies to, and why not to lower it outside development (#420).

---

ドキュメントのみの更新です。アプリケーションに変更はありません。

**ドキュメント**

- 0.13.0 で追加したパスワード変更のドキュメントを整備しました。利用者ガイドにフォームの場所と条件（15 文字以上、zxcvbn スコア 4 段階中 3 以上、および自分のメールアドレス・ユーザー名・表示名から作ったものは長さを満たしても通らないこと）を追記し、システム管理者ガイドに `PASSWORD_MIN_SCORE` の適用範囲と、開発環境以外で下げるべきでない理由を追加しました（#420）。

## [0.13.0] - 2026-08-12

**Highlights**

- **Change your own password.** Signing in with a password no longer means asking an administrator to change it. The profile page now carries a password form, and every place a password is set — sign-up, the admin user screen, the `db:create-user` script — is held to the same strength policy: at least 15 characters, and a zxcvbn guessability score of 3 out of 4. `PASSWORD_MIN_SCORE` can lower the score requirement for local development; the length minimum applies regardless (#397).
- **Member counts on the organization and category lists.** The dashboard lists now show how many people belong to each organization and category, without opening it. The count appears only for a viewer who is a member of that organization or category — everyone else sees the list unchanged (#409).
- **A purge now removes the row data it left behind.** Purging a dataset was leaving its row-level tables in DuckLake: the query that decides which resources have row data was comparing a row to itself and finding none. The data was gone from every interface but still resident in the lake, and no error was raised. Purges run from this release remove it. Data purged before it may still be present, and re-purging is not possible once the dataset is gone — please contact us if this matters for your deployment (#414).

**Features**

- feat: self-service password change, gated by a strength policy (#397)
- feat: show member counts on the organization and category lists (#409)

**Bug Fixes**

- fix(api): correlate the purge and backfill subqueries through drizzle (#414)
- fix(api): stop self-service renames through Better Auth's update-user (#400)
- fix(worker): pace one host's health checks at the rate it asks for (#403)

**Internal**

- Raw SQL that Drizzle can express natively has been swept out of the query layer, and a lint rule now rejects the pattern behind #414 — a hand-written correlated subquery in a select projection, which Drizzle silently strips the table qualifier from (#410, #412, #413, #414, #416, #417, #418).
- refactor(ui): adopt shadcn Field and InputGroup so forms stop hand-rolling aria wiring (#408)

---

**ハイライト**

- **自分でパスワードを変更できるようになりました。** パスワードでサインインしている場合、変更のたびに管理者へ依頼する必要がなくなります。プロフィールページにパスワード変更フォームを追加し、サインアップ・管理者のユーザー画面・`db:create-user` スクリプトを含め、パスワードを設定するすべての箇所に同じ強度ポリシーを適用しました（15 文字以上、zxcvbn の推測困難性スコア 4 段階中 3 以上）。`PASSWORD_MIN_SCORE` でスコア要件を下げられますが、開発用途向けです。文字数の下限は設定に関わらず適用されます（#397）。
- **組織・カテゴリ一覧にメンバー数を表示。** ダッシュボードの一覧で、各組織・カテゴリの所属人数が開かずに分かるようになりました。表示されるのはその組織・カテゴリのメンバーに対してのみで、それ以外の利用者には従来どおりの表示です（#409）。
- **パージがデータ本体を残していた問題を修正。** データセットのパージ後も、行レベルのテーブルが DuckLake に残っていました。どのリソースが行データを持つかを判定するクエリが、行を自分自身と比較して常に該当なしと答えていたためです。画面上はすべて削除されているのにデータ本体は残り、エラーも出ない状態でした。本リリース以降のパージでは削除されます。**本リリース以前にパージしたデータは残っている可能性があり、データセットが消えているため再パージはできません。** 該当する場合はご連絡ください（#414）。

**機能**

- 強度ポリシー付きのセルフサービスなパスワード変更（#397）
- 組織・カテゴリ一覧へのメンバー数表示（#409）

**バグ修正**

- パージと backfill の相関サブクエリを Drizzle で組み立てるよう修正（#414）
- Better Auth の update-user 経由での自己名称変更を遮断（#400）
- ヘルスチェックを相手ホストが求める間隔に合わせて実行（#403）

**内部**

- Drizzle でそのまま表現できる生 SQL をクエリ層から一掃し、#414 の原因となったパターン（投影内に手書きした相関サブクエリ。Drizzle がテーブル修飾を静かに落とす）を lint で機械的に弾くようにしました（#410, #412, #413, #414, #416, #417, #418）。
- フォームの aria 属性の手組みをやめ、shadcn の Field / InputGroup を採用（#408）

## [0.12.0] - 2026-08-10

**Required After Upgrading**

- **Run the one-time version backfill.** Resources created before this release have no version, and until they have one they are outside everything this release adds: no history, no downloadable past version, no row-level diff. Nothing backfills them on its own, and it is the only manual step this release asks for. Sign in as a site administrator and use the **Version backfill** prompt on the dashboard — it records each resource's current file as v1 and loads tabular versions into the row-level diff. Nothing is re-fetched, re-indexed, or copied, and the prompt disappears once the migration is complete (#157).

**Highlights**

- **Resources keep their history.** Replacing a resource's file no longer discards what was there. The previous file is retained as a numbered version, and every version can be downloaded exactly as it was. A version is only created when the content actually changed, so re-fetching an unchanged external URL adds nothing and says so. When the law requires it, a version can be permanently destroyed — and the erasure reaches the derived layers too: its Parquet preview, its row-level diff snapshot, and the extracted text held for search (#155, #177, #193, #233).
- **CSV and TSV resources show what changed between two versions, row by row.** The row-level diff is computed in DuckLake and reports rows added and removed. Without a declared primary key an edited row necessarily reads as one removal and one addition, and the diff states that it was computed without a key rather than leaving you to guess (#167, #370).
- **A pipeline run can be stopped, and its content put back.** A resource being fetched or interpreted can be interrupted from the dashboard, the content reverted to the version before it, and a resource left half-done now says so instead of looking finished (#212, #213, #214).
- **CSV interpretation now runs on DuckDB.** Column types, previews, and per-column statistics all come from one pass over the file, so the schema and the Parquet preview can no longer describe different things, and leading-zero codes and over-long integers keep their digits. A version's format is settled from its own bytes rather than inherited (#241, #254).

**Features**

- **Create a dataset from a URL, not only from a file.** The new-dataset page accepts an external URL as the first resource, so a catalog that links to files hosted elsewhere no longer has to upload them first (#351).
- **Delete and restore a dataset from the dashboard.** A deleted dataset now leaves the public listings immediately, and a restore puts it back (#341).
- **Reach the public page from the dashboard.** Dashboard listings and editors link to the page a visitor sees (#340).
- **Rows open their editor.** Clicking a dataset, resource, organization, category, announcement, or user row opens its editor rather than requiring the action menu (#156, #158).
- **The dashboard says why a resource failed.** A resource whose pipeline errored shows the reason to users who may edit that dataset, instead of reporting only that something went wrong (#334).
- **A one-time version backfill for resources that predate versioning.** A site administrator sees a prompt on the dashboard and can record each existing resource's current file as v1, and load tabular versions into the row-level diff. Nothing is re-fetched or re-indexed, and the prompt disappears once the migration is done (#157).

**Bug Fixes**

- **Japanese single-byte encodings are re-checked.** When the detector settled on a single-byte encoding, a Japanese file could be decoded as something else; a Japanese-specific detector now gets the final say (#345).
- **Replacing a resource's file keeps its editor open** instead of closing it out from under you (#339).
- **A dataset's resource list settles once, not on every render,** which was causing needless refetching in the dashboard (#348).
- **A restored dataset is rebuilt in the search index,** and a refused request is reported as itself rather than as a generic failure (#342).
- **Redirect hops obey the limits the first request obeys,** and a redirect no longer carries credentials or downgrades the scheme (#314, #330).
- **An upload's promotion is bound to the key it was written to,** and a replacement's metadata is held until its bytes land rather than describing content that has not arrived (#185, #187).
- **Objects left behind by earlier crashed runs are reclaimed.** Storage objects are now recorded before they are written, and a reconciliation pass names the ones that leaked before that ledger existed so they can be cleaned up (#215, #328).
- **The health checker gets a column of its own** instead of sharing the metadata column, and a per-host budget instead of only an overall one (#359, #368).

**Performance**

- **Preview Parquet is compressed with ZSTD,** measured at 3.25 MB against Snappy's 8.40 MB on the same input, so a preview page costs about a third of the bytes to fetch. Files written before this stay Snappy and are still read (#303).
- **The DuckDB-WASM binaries are emitted as build assets,** retiring the copy step that staged them beside the build (#301).
- **A host is resolved once per batch, not once per URL,** during link health checks (#324).
- **Content that is already derived is not derived again** when a run re-runs over unchanged bytes (#343).

**Security**

- **DNS resolution goes through c-ares, restoring the SSRF address check** that the platform resolver had bypassed (#309).
- **Blocked names are refused at the connection,** and a refused fetch says why (#357).
- **One SSRF blocklist, called by both the API and the worker,** rather than two that could drift apart (#318).

**Maintenance**

- Updated `openai` to 7.x, `jsdom` to 30.x, `js-yaml` to 5.x, and `@testing-library/jest-dom` to 7.x, and cleared the remaining dependency advisories (#211, #282, #283, #377, #380).
- Tests in the API, worker, and lake packages are now type-checked (#217, #218, #347).
- Integration tests run in parallel with one database per pool slot (#322), and CI carries the turbo and pnpm caches between runs (#325, #326).

**Deployment**

- This release adds migrations 0017–0035, introducing the version, orphaned-object, and pipeline-claim tables and adding columns to `resource`. The worker applies them at startup, so no manual step is needed. Changes to tables introduced within this release are self-contained; no pre-existing table loses a column.
- Container images now ship the DuckDB extensions (`httpfs`, `aws`, `postgres`, `ducklake`), installed at build time. A closed-network deployment therefore needs no egress to `extensions.duckdb.org`, at the cost of a larger image.

---

**アップグレード後に必要な作業**

- **一度きりのバージョン補完を実行してください。** 本リリース以前に作成されたリソースには版がありません。版が付くまで、そのリソースは本リリースで追加された機能の外側にあります（履歴なし・過去版のダウンロード不可・行レベル差分なし）。自動では補完されず、本リリースで手動作業が必要なのはこれだけです。サイト管理者でサインインし、ダッシュボードに表示される「**バージョンの補完**」を実行してください。各リソースの現在のファイルが v1 として記録され、表形式の版が行レベル差分に取り込まれます。再取得・再インデックス・コピーは行われず、完了すると案内は表示されなくなります（#157）。

**ハイライト**

- **リソースが履歴を保持するようになりました。** リソースのファイルを差し替えても、それまでの内容は破棄されません。差し替え前のファイルは版番号付きで保持され、各版は当時のままダウンロードできます。版が作られるのは内容が実際に変わったときだけなので、外部 URL を再取得しても中身が同じなら版は増えず、その旨が表示されます。法的な要請がある場合は特定の版を完全に消去でき、消去は派生層にも及びます（Parquet プレビュー、行レベル差分のスナップショット、検索用に保持している抽出テキスト）（#155、#177、#193、#233）。
- **CSV / TSV リソースは、版と版の間で何が変わったかを行単位で表示します。** 行レベル差分は DuckLake 上で計算され、追加・削除された行を報告します。主キーの指定がない状態では編集された行は「削除 1 行 + 追加 1 行」として現れますが、差分自体が「主キーなしで計算した」と明示するので、読み手が推測する必要はありません（#167、#370）。
- **パイプラインの実行を停止し、内容を元に戻せます。** 取得中・解釈中のリソースをダッシュボードから中断し、直前の版へ内容を戻せます。中途半端な状態で終わったリソースは、完了しているように見せるのではなく、その旨を表示します（#212、#213、#214）。
- **CSV の解釈が DuckDB 上で動くようになりました。** 列の型・プレビュー・列ごとの統計をファイル 1 回の走査からまとめて得るため、スキーマと Parquet プレビューが食い違うことがなくなり、先頭ゼロのコードや桁数の多い整数も桁を落としません。版のフォーマットは、引き継ぐのではなく、その版自身のバイト列から確定します（#241、#254）。

**新機能**

- **ファイルだけでなく URL からもデータセットを作成できます。** データセット新規作成画面が最初のリソースとして外部 URL を受け付けるため、外部でホストされたファイルを参照するカタログでも、いったんアップロードする必要がなくなりました（#351）。
- **ダッシュボードからデータセットを削除・復元できます。** 削除したデータセットは公開一覧から即座に消え、復元すれば戻ります（#341）。
- **ダッシュボードから公開ページへ移動できます。** 一覧と編集画面から、来訪者が見るページへのリンクを張りました（#340）。
- **行のクリックで編集画面が開きます。** データセット・リソース・組織・カテゴリー・お知らせ・ユーザーの各行をクリックすると、アクションメニューを経由せず編集画面が開きます（#156、#158）。
- **リソースが失敗した理由をダッシュボードが表示します。** パイプラインがエラーになったリソースについて、「失敗した」ことだけでなくその理由を、当該データセットを編集できるユーザーに表示します（#334）。
- **バージョン管理導入前のリソース向けに、一度きりの補完機能を追加しました。** サイト管理者のダッシュボードに案内が表示され、実行すると既存リソースの現在のファイルを v1 として記録し、表形式の版を行レベル差分に取り込みます。再取得・再インデックスは行わず、完了すると案内は表示されなくなります（#157）。

**バグ修正**

- **日本語のシングルバイト系エンコーディングを再判定します。** 検出器がシングルバイトのエンコーディングに落ち着いた場合、日本語のファイルが別の文字コードとして解釈されることがありました。日本語向けの検出器が最終判断を下すようにしました（#345）。
- **リソースのファイルを差し替えても編集画面が開いたままになります。** 従来は操作の途中で編集画面が閉じてしまっていました（#339）。
- **データセットのリソース一覧が、レンダーのたびではなく一度だけ確定します。** ダッシュボードで不要な再取得が発生していました（#348）。
- **復元したデータセットが検索インデックスに再構築され、**拒否されたリクエストは汎用エラーではなくそれ自身として報告されます（#342）。
- **リダイレクト先も最初のリクエストと同じ上限に従い、**リダイレクトが認証情報を持ち越したりスキームを降格したりしなくなりました（#314、#330）。
- **アップロードの昇格が書き込み先のキーに束縛され、**差し替えのメタデータは、まだ到着していない内容を説明してしまわないよう、バイト列が着地するまで保留されます（#185、#187）。
- **過去にクラッシュした実行が残したオブジェクトを回収します。** ストレージオブジェクトを書き込み前に台帳へ記録するようにし、台帳が無かった時代にリークしたものは突合処理が指名するので、片付けられるようになりました（#215、#328）。
- **ヘルスチェッカーがメタデータ列を間借りせず専用の列を持ち、**全体だけでなくホストごとの予算を持つようになりました（#359、#368）。

**パフォーマンス**

- **プレビュー Parquet を ZSTD で圧縮するようにしました。** 同一入力で Snappy の 8.40 MB に対し 3.25 MB という実測で、プレビュー 1 ページの取得バイト数がおよそ 1/3 になります。これ以前に書かれたファイルは Snappy のままで、引き続き読めます（#303）。
- **DuckDB-WASM のバイナリをビルド成果物として出力するようにし、**ビルド脇へ配置していたコピー手順を廃止しました（#301）。
- **リンク切れチェックで、ホスト名の解決を URL ごとではなくバッチごとに 1 回**にしました（#324）。
- **既に派生済みの内容から再度派生しません**（#343）。

**セキュリティ**

- **DNS 解決を c-ares 経由にし、SSRF のアドレス検査を復旧しました。** プラットフォームのリゾルバ経由では検査を迂回していました（#309）。
- **ブロック対象のホスト名を接続の時点で拒否し、**拒否された取得はその理由を返します（#357）。
- **SSRF ブロックリストを API と Worker で 1 つに統一しました。** 2 つに分かれていると内容が乖離しうるためです（#318）。

**保守**

- `openai` を 7 系、`jsdom` を 30 系、`js-yaml` を 5 系、`@testing-library/jest-dom` を 7 系へ更新し、残っていた依存関係の脆弱性勧告を解消しました（#211、#282、#283、#377、#380）。
- API・Worker・lake パッケージのテストを型検査の対象にしました（#217、#218、#347）。
- 統合テストをプールスロットごとに 1 データベースで並列実行し（#322）、CI が turbo と pnpm のキャッシュを実行間で持ち越すようにしました（#325、#326）。

**デプロイ**

- 本リリースはマイグレーション 0017〜0035 を追加し、バージョン・孤立オブジェクト・パイプライン claim のテーブルを新設して `resource` に列を追加します。Worker が起動時に適用するため、手動での実行は不要です。本リリース内で追加されたテーブルへの変更は自己完結しており、既存テーブルから列が失われることはありません。
- コンテナイメージが DuckDB 拡張（`httpfs` / `aws` / `postgres` / `ducklake`）を同梱するようになりました。ビルド時にインストールするため、閉域網デプロイでも `extensions.duckdb.org` への通信は不要です。その分イメージサイズは増加します。

## [0.11.6] - 2026-08-04

**Highlights**

- **The dashboard now shows only what you can actually act on, and says why when something is refused.** Organization and category management no longer offers edit and member buttons to users without the rights to use them, dataset management lists the datasets you can write in rather than every dataset you can see, and a rejected request now names the field that was wrong instead of failing with an unexplained error (#279).

**Bug Fixes**

- **Dropping a file on the new dataset page keeps what you already typed.** The drop created the draft through a separate path that ignored the form, so a title, description, or tags entered before the drop were discarded. The drop now submits the form itself and every field carries into the draft (#279).
- **Buttons and dialog close controls show the pointer cursor again.** Tailwind CSS v4's preflight leaves `<button>` at the browser default, so the shared button component and the dialog and sheet close controls set `cursor: pointer` explicitly (#279).
- **Organization and category management offers actions only where the viewer may use them.** Every signed-in user previously saw edit and member buttons for every organization and category, and the edit pages were reachable regardless of role, so the action failed only on save. Buttons now appear for administrators of that organization or category, and everyone else gets a read-only view of the same details (#279).
- **Dataset management is scoped to the organizations you can write in.** Datasets belonging to an organization where you are a plain member — visible to you, but not editable — appeared in the management list and could not be saved. The list, the organization filter, and the owner-organization selector on the dataset form now all use organizations where you are an editor or higher, and the selector is preselected when exactly one is available (#279).
- **Organization and category lists have a stable order.** The organization list had no `ORDER BY`, so rows could shift between requests and paginate inconsistently. Both lists now sort by name by default and accept `orderBy=name|datasetCount` (#279).
- **Search facets come back in descending count order.** The step that enriches facets with titles rebuilt the list from the database in its own order, discarding the ordering the search backend had computed, so organization and category facets appeared in an arbitrary order (#279).
- **Rejected requests and failed processing explain themselves.** Request validation answered with a Problem Details response that carried no `detail`, leaving the UI nothing to show but "the request failed" — an invalid resource URL, for example, gave no hint that the URL was the problem. Validation failures now name the field and the reason, and a resource's pipeline error is shown in full to users who may edit that dataset (#279).

**API Changes**

- `GET /api/v1/packages?my_org=true` and the resource count endpoint now mean "organizations where the caller is an editor or higher" rather than "any organization the caller belongs to". Callers relying on the previous behavior to list datasets they can only read should omit `my_org` and filter client-side (#279).

---

**ハイライト**

- **ダッシュボードが「操作できるものだけ」を表示し、拒否された理由を伝えるようになりました。** 組織・カテゴリー管理は権限のないユーザーに編集・メンバーボタンを出さなくなり、データセット管理は閲覧できる全件ではなく編集できるものを一覧し、リクエストが拒否された際は原因不明のエラーではなく問題のあったフィールドを示すようになりました（#279）。

**バグ修正**

- **データセット新規作成でファイルをドロップしても入力済みの内容が保持されます。** ドロップはフォームを参照しない別経路で下書きを作成していたため、ドロップ前に入力したタイトル・説明・タグが破棄されていました。ドロップがフォーム自身を送信するようになり、全フィールドが下書きに引き継がれます（#279）。
- **ボタンとダイアログの閉じるコントロールにポインターカーソルが戻りました。** Tailwind CSS v4 の preflight は `<button>` をブラウザ既定のカーソルのままにするため、共有ボタンコンポーネントとダイアログ・シートの閉じるコントロールで `cursor: pointer` を明示しました（#279）。
- **組織・カテゴリー管理は、その操作を行える相手にだけ操作を提示します。** 従来はログインした全ユーザーにすべての組織・カテゴリーの編集・メンバーボタンが表示され、編集画面もロールに関わらず開けたため、保存時に初めて失敗していました。ボタンは当該組織・カテゴリーの管理者にのみ表示し、それ以外のユーザーには同じ内容の読み取り専用ビューを表示します（#279）。
- **データセット管理を、編集権限のある組織に絞りました。** 閲覧はできるが編集はできない（メンバーとして所属する）組織のデータセットが管理一覧に現れ、保存できない状態でした。一覧・組織フィルター・データセットフォームの所属組織セレクトのいずれも editor 以上の組織を対象とし、候補が 1 件だけの場合は自動選択します（#279）。
- **組織・カテゴリー一覧の並び順が安定しました。** 組織一覧には `ORDER BY` が無く、リクエストごとに順序が変わってページングが崩れることがありました。どちらの一覧も既定で名前順に並び、`orderBy=name|datasetCount` を受け付けます（#279）。
- **検索ファセットが件数の降順で返るようになりました。** ファセットにタイトルを付与する処理が独自の順序でリストを再構築し、検索バックエンドが算出した順序を捨てていたため、組織・カテゴリーのファセットが不定の順序で表示されていました（#279）。
- **拒否されたリクエストと失敗した処理が理由を返します。** リクエストバリデーションの Problem Details に `detail` が無く、UI は「リクエストに失敗しました」としか表示できませんでした（例: 不正なリソース URL でも URL が原因だと分かりませんでした）。バリデーション失敗はフィールド名と理由を返し、リソースのパイプラインエラーは当該データセットを編集できるユーザーにはそのまま表示します（#279）。

**API 変更**

- `GET /api/v1/packages?my_org=true` とリソース件数エンドポイントの `my_org` は、「所属するすべての組織」ではなく「editor 以上のロールを持つ組織」を意味するようになりました。閲覧のみ可能なデータセットを一覧する用途で従来の挙動に依存していた場合は、`my_org` を外してクライアント側で絞り込んでください（#279）。

## [0.11.5] - 2026-07-21

**Security**

- **OpenSearch Docker base image pinned by digest.** The kuromoji-enabled OpenSearch image is now pinned to its manifest digest, completing digest pinning across every container image, and Dependabot watches the `docker/` directory to bump it as the tag moves (#148).

**Maintenance**

- **Updated the `upload-artifact` action** used by the Scorecard workflow to its latest major version (#150).

---

**セキュリティ**

- **OpenSearch の Docker ベースイメージを digest で固定。** kuromoji プラグイン入りの OpenSearch イメージをマニフェスト digest で固定し、全コンテナイメージの digest 固定が完了しました。Dependabot が `docker/` ディレクトリを監視して digest を追従更新します（#148）。

**保守**

- **Scorecard ワークフローが使う `upload-artifact` アクションを最新メジャーに更新しました**（#150）。

## [0.11.4] - 2026-07-21

**Security**

- **Docker base image pinned by digest.** The Node base image is now pinned to its manifest digest for a reproducible, tamper-evident build, and Dependabot bumps the digest as the upstream tag moves (#145).
- **OpenSSF Scorecard analysis and badge.** A scheduled OpenSSF Scorecard workflow publishes supply-chain security results and surfaces them as a README badge (#146).

---

**セキュリティ**

- **Docker ベースイメージを digest で固定。** Node ベースイメージをマニフェスト digest で固定し、再現性・改ざん検知性を確保しました。Dependabot が上流タグの移動に合わせて digest を追従更新します（#145）。
- **OpenSSF Scorecard 分析とバッジ。** OpenSSF Scorecard の定期ワークフローがサプライチェーンのセキュリティ結果を公開し、README バッジとして表示します（#146）。

## [0.11.3] - 2026-07-21

**Security**

- **All dependency vulnerabilities reported by `pnpm audit` are resolved.** 29 advisories (10 high / 14 moderate / 5 low) were cleared by updating direct dependencies (including Astro to 7.x) and adding scoped `pnpm.overrides` for transitive packages, with no breaking major bumps to runtime libraries (#125).
- **Supply-chain hardening for CI.** All GitHub Actions are now pinned to full commit SHAs, workflow token permissions are scoped to least privilege, and Dependabot plus CodeQL static analysis run continuously (#124).

**Bug Fixes**

- **Multi-site databases now get their PostgreSQL extensions.** A newly deployed site previously failed to start because its per-site database role lacks the privilege to `CREATE EXTENSION`, so the worker's startup migration errored and tripped the ECS circuit breaker. The site-database provisioner now creates `pg_trgm` and `vector` as the master user, so first deploys succeed (#142).

**Maintenance**

- **Removed a deprecated CDK pattern.** The per-site database construct now uses an explicit `logGroup` instead of the deprecated `logRetention`, which also drops the extra `Custom::LogRetention` helper resources from the synthesized template (#143).
- **Dependencies and pinned action versions updated**, including aws-cdk-lib, Next.js, better-auth, and the CodeQL / checkout / setup-node / upload-pages-artifact / create-github-app-token actions (#141, #131, #127, #129, #130, #128, #139, #135).

**Documentation**

- **Guidance on multi-environment AWS accounts.** The docs now recommend separate AWS accounts for dev and prd, and document the ECR asset-tag push conflict that can occur when the same commit is deployed to two environments in one account near-simultaneously, along with how to avoid it (#137).

---

**セキュリティ**

- **`pnpm audit` が検出した依存脆弱性をすべて解消しました。** 29 件（high 10 / moderate 14 / low 5）を、直接依存の更新（Astro の 7.x 化を含む）と推移的依存への範囲限定の `pnpm.overrides` で解消し、ランタイムライブラリのメジャー更新による破壊は避けました（#125）。
- **CI のサプライチェーン強化。** すべての GitHub Actions をコミット SHA に固定し、ワークフローのトークン権限を最小化、Dependabot と CodeQL 静的解析を常時実行するようにしました（#124）。

**バグ修正**

- **マルチサイトのデータベースに PostgreSQL 拡張が作成されるようになりました。** 従来、新規デプロイしたサイトは、サイト単位の DB ロールに `CREATE EXTENSION` 権限が無いため Worker 起動時のマイグレーションが失敗し、ECS circuit breaker が発動して起動できませんでした。サイト DB のプロビジョナーがマスターユーザーで `pg_trgm` / `vector` を作成するようにし、初回デプロイが成功します（#142）。

**保守**

- **非推奨の CDK パターンを解消しました。** サイト DB construct が非推奨の `logRetention` ではなく明示的な `logGroup` を使うようになり、合成テンプレートから余分な `Custom::LogRetention` ヘルパーリソースも削除されます（#143）。
- **依存とアクションの固定バージョンを更新しました**（aws-cdk-lib・Next.js・better-auth、CodeQL / checkout / setup-node / upload-pages-artifact / create-github-app-token アクション等。#141, #131, #127, #129, #130, #128, #139, #135）。

**ドキュメント**

- **マルチ環境の AWS アカウント運用に関する指針。** dev と prd で AWS アカウントを分けることを推奨し、同一アカウントで同一コミットをほぼ同時にデプロイした際に起こり得る ECR アセットタグの push 競合とその回避方法を明記しました（#137）。

## [0.11.2] - 2026-07-21

**Bug Fixes**

- **AWS deploys no longer need Docker to bundle the site-database Lambda.** The infrastructure package now declares `esbuild` directly, so the `NodejsFunction` bundling used by the multi-site database bootstrap always runs esbuild locally instead of falling back to a Docker build. This unblocks `cdk synth` / `cdk deploy` in environments without Docker (for example CodeBuild), which forks could previously hit because esbuild was only available at the workspace root (#122).

---

**バグ修正**

- **AWS デプロイでサイト DB 用 Lambda のバンドルに Docker が不要になりました。** infra パッケージが `esbuild` を直接依存するようになり、マルチサイトのデータベースブートストラップが使う `NodejsFunction` のバンドルが常にローカルの esbuild で実行されます（Docker バンドルへのフォールバックを回避）。従来は esbuild がワークスペースのルートにしか無く、フォークの `cdk synth` / `cdk deploy` が Docker の無い環境（例: CodeBuild）で失敗し得ましたが、これが解消されます（#122）。

## [0.11.1] - 2026-07-21

**Improvements**

- **A site's `brand` now treats `'default'` exactly like leaving it unset.** After the multi-brand refactor the default brand is a real brand named `default`, so writing `brand: 'default'` and omitting the field are now equivalent — both build the default web image with no `KUKAN_BRAND` build argument. Previously an explicit `'default'` passed an unnecessary build argument that produced a different image asset hash for the same image. The environment-config reference documents the field's default value accordingly (#120).

---

**改善**

- **サイトの `brand` で `'default'` を指定した場合と未指定を完全に同じ扱いにしました。** マルチブランド化でデフォルトブランドは `default` という名前の実在ブランドになったため、`brand: 'default'` と省略は等価になり、どちらも `KUKAN_BRAND` ビルド引数なしでデフォルトの web イメージをビルドします。従来は明示的な `'default'` が不要なビルド引数を渡し、同じイメージなのにアセットハッシュが変わっていました。環境設定リファレンスにも既定値を明記しています（#120）。

## [0.11.0] - 2026-07-20

**Breaking Changes**

- **The default brand moved from `apps/web/src/brand/` to `apps/web/brands/default/`.** Multi-brand support (ADR-042) consolidates every brand under `apps/web/brands/`, and the default brand now lives alongside the others. Forks that customized the brand must run `git mv apps/web/src/brand apps/web/brands/default` once when upgrading, and move any static assets from `apps/web/public/brand/` to `apps/web/brands/default/public/`. The `@/brand` imports and the runtime `/brand/...` URLs are unchanged, so no application code changes are needed. See the "Appearance Customization" guide for the full migration (#118).

**Highlights**

- **One fork can now ship multiple brands, one per site (ADR-042).** A `KUKAN_BRAND` build argument selects which brand under `apps/web/brands/` becomes the web image's look — its configuration, theme, messages, component overrides, static pages, and assets. Only the selected brand enters a build, so brands never mix in a bundle. In a multi-site deployment each site's `brand` in the environment definition drives a per-site image, so several municipalities can share one fork while each keeps its own identity. The default brand needs no configuration and builds exactly as before (#118).
- **Multi-site is now on equal footing with single-site and can be the default shape (ADR-041).** New deployments can start multi-site from day one, because the three rough edges are gone: the us-east-1 ACM certificate and WAF WebACL are auto-created for site domains in standalone mode (matching single-site), AWS Backup works for multi-site with the shared database backed up once and each site's bucket backed up per site, and a burstable shared OpenSearch is a synth warning rather than a hard error. The example configuration now presents the multi-site shape first, keeping the single-site layout as a backward-compatible option, and a new environment-config reference documents every field (#117).

**Features**

- feat(infra): give multi-site parity with single-site so it can be the default (ADR-041) (#117)
- feat(web)!: multi-brand build via KUKAN_BRAND (ADR-042) (#118)

---

**破壊的変更**

- **デフォルトブランドの置き場所が `apps/web/src/brand/` から `apps/web/brands/default/` へ移動しました。** マルチブランド対応（ADR-042）で全ブランドを `apps/web/brands/` 配下に統合し、デフォルトブランドも他のブランドと同じ場所に置くようにしたためです。ブランドをカスタマイズしていたフォークは、アップグレード時に一度だけ `git mv apps/web/src/brand apps/web/brands/default` を実行し、`apps/web/public/brand/` に置いていた静的アセットは `apps/web/brands/default/public/` へ移してください。`@/brand` のインポートと実行時の `/brand/...` URL は不変なので、アプリケーションコードの変更は不要です。詳しい移行手順は「外観カスタマイズ」ガイドを参照してください（#118）。

**ハイライト**

- **1 つのフォークでサイトごとに異なるブランドを配布できるようになりました（ADR-042）。** ビルド引数 `KUKAN_BRAND` で、`apps/web/brands/` 配下のどのブランド（設定・テーマ・文言・コンポーネント差し替え・静的ページ・アセット）を web イメージの見た目にするかを選択します。ビルドに入るのは選択した 1 ブランドのみで、ブランド同士がバンドルで混ざりません。マルチサイト構成では環境定義の各サイトの `brand` がサイトごとのイメージを決めるため、複数自治体が 1 つのフォークを共有しつつ、それぞれ独自の見た目を保てます。デフォルトブランドは設定不要で、従来どおりビルドされます（#118）。
- **マルチサイトがシングルサイトと同等になり、標準の構成として選べるようになりました（ADR-041）。** 3 つの引っかかりが解消され、新規構築は最初からマルチサイトで始められます。us-east-1 の ACM 証明書と WAF WebACL は standalone モードでサイトドメイン分が自動作成され（シングルサイトと同じ）、AWS Backup はマルチサイトでも利用可能になり（共有データベースは 1 回、各サイトのバケットはサイトごとにバックアップ）、burstable な共用 OpenSearch は synth 時のエラーではなく警告になりました。サンプル設定はマルチサイト形状を第一に提示してシングルサイト構成を後方互換の選択肢として残し、全フィールドを説明する環境設定リファレンスを新設しました（#117）。

**機能**

- feat(infra): マルチサイトをシングルサイトと同等にし標準構成として選べるように（ADR-041）（#117）
- feat(web)!: `KUKAN_BRAND` によるマルチブランドビルド（ADR-042）（#118）

## [0.10.0] - 2026-07-19

**Highlights**

- **Multi-site deployment: run multiple data catalog sites on one shared infrastructure (ADR-041).** One operator can now host several sites — for example, data catalogs for multiple municipalities — while sharing the hourly-billed backbone (database cluster, OpenSearch domain, VPC, ECS cluster) and keeping everything that holds data isolated per site: each site gets its own PostgreSQL database with a dedicated role that cannot reach other sites' data, plus its own search index, S3 bucket, SQS queue, web/worker services, and CloudFront distribution with its own domain. Multi-site is strictly opt-in via a `sites` list in the environment definition; environments without it keep today's single-stack layout unchanged (#106, #107, #108).
- **The multi-site configuration validates itself before anything reaches CloudFormation.** Site names, per-site certificate requirements, and the shared database's connection budget are checked at synth. The connection check uses the AWS-documented Aurora Serverless v2 limits (including the 2,000-connection cap that a 0/0.5 minimum ACU imposes and the 5,000 absolute ceiling), counts the extra connections of one site's rolling update, and its messages tell you which setting actually helps — including when none does and the sites should be split across clusters (#111, #113, #115).
- **On-premises multi-site with Docker Compose.** Opt-in templates under `docker/multi-site/` build the same shared-boxes/per-site model with Compose: one shared stack (PostgreSQL / MinIO / ElasticMQ / OpenSearch / Ollama / Caddy) plus one web/worker pair per site, with a runbook covering setup, adding and purging sites, capacity planning, and the security boundary of the shared services (#109).
- **A golden-set evaluation harness for AI metadata suggestions.** `pnpm eval:suggest` runs a golden dataset file against a live instance and reports per-field scores, latency, and hallucination canaries — built for comparing models, providers, and prompt changes side by side. The admin dashboard now also shows a quality caveat when suggestions run on a local model (#104, #105).

**Features**

- feat(api): add golden-set evaluation harness for AI metadata suggestions (#104)
- feat(web): show a quality caveat when AI suggestions run on a local model (#105)
- feat(search): wire OPENSEARCH_INDEX_PREFIX through to the OpenSearch adapter (ADR-041) (#107)
- feat(infra): add multi-site SharedStack/SiteStack deployment (ADR-041) (#108)
- feat(docker): add opt-in multi-site compose templates (ADR-041) (#109)
- feat(infra): validate the shared-database connection budget at synth (ADR-041) (#111)

**Bug Fixes**

- fix(infra): reject site-scoped fields on multi-site environment entries (ADR-041) (#113)

**Improvements**

- refactor(infra): add synth snapshot guard and extract stack composition (ADR-041) (#106)
- refactor: simplify the ADR-041 series and fix review findings (#115)

**Documentation**

- docs(adr): add ADR-041 multi-site deployment and ADR-042 multi-brand build (#61)
- docs: mark ADR-041 as accepted and add multi-site deployment guide (#110)
- docs(site): add multi-site operation guide (#112)
- docs(site): add multi-site deployment spotlight to the landing page (#114)

---

**ハイライト**

- **マルチサイトデプロイ: 1 つの共有インフラで複数のデータカタログサイトを運用できるようになりました(ADR-041)。** 複数自治体のデータカタログのように、1 つの運用主体が複数サイトをホストする際、時間課金される基盤(データベースクラスタ、OpenSearch ドメイン、VPC、ECS クラスタ)を共有しつつ、データを持つものはすべてサイト別に分離します — 各サイトは他サイトのデータへ到達できない専用ロール付きの PostgreSQL データベースを持ち、検索インデックス・S3 バケット・SQS キュー・web/worker サービス・独自ドメイン付き CloudFront もサイトごとに独立します。マルチサイトは環境定義の `sites` リストによる完全な opt-in で、`sites` の無い環境は従来の単一スタック構成がそのまま維持されます(#106, #107, #108)。
- **マルチサイト設定は CloudFormation に到達する前に自己検証されます。** サイト名、サイトごとの証明書要件、共有データベースの接続数バジェットを synth 時に検査します。接続数の検査は AWS 公式ドキュメントの Aurora Serverless v2 上限(最小 0/0.5 ACU 時の 2,000 接続キャップ、絶対上限 5,000 を含む)に基づき、ローリング更新中の 1 サイト分の追加接続も計上します。エラーメッセージは「どの設定を変えれば実際に解決するか」— どの設定でも解決せずクラスタ分割が必要な場合を含めて — を案内します(#111, #113, #115)。
- **Docker Compose によるオンプレミスのマルチサイト構成。** `docker/multi-site/` の opt-in テンプレートが同じ「箱共有・サイト別分離」モデルを Compose で構成します: 共有スタック(PostgreSQL / MinIO / ElasticMQ / OpenSearch / Ollama / Caddy)1 つ + サイトごとの web/worker ペア。セットアップ、サイトの追加・削除、キャパシティ計画、共有サービスのセキュリティ境界を手順書にまとめています(#109)。
- **AI メタデータ提案のゴールデンセット評価ハーネス。** `pnpm eval:suggest` がゴールデンデータセットを稼働中のインスタンスに対して実行し、フィールド別スコア・レイテンシ・ハルシネーション検出をレポートします — モデル・プロバイダー・プロンプト変更の比較用です。あわせて、ローカルモデルで提案が動作している場合に管理画面へ品質注記を表示するようになりました(#104, #105)。

**機能**

- feat(api): AI メタデータ提案のゴールデンセット評価ハーネスを追加（#104）
- feat(web): ローカルモデルで AI 提案が動作する場合に品質注記を表示（#105）
- feat(search): `OPENSEARCH_INDEX_PREFIX` を OpenSearch アダプターへ配線（ADR-041）（#107）
- feat(infra): マルチサイト SharedStack/SiteStack デプロイを追加（ADR-041）（#108）
- feat(docker): opt-in のマルチサイト compose テンプレートを追加（ADR-041）（#109）
- feat(infra): 共有データベースの接続数バジェットを synth 時に検証（ADR-041）（#111）

**バグ修正**

- fix(infra): マルチサイト環境の env エントリでサイトスコープのフィールドを拒否（ADR-041）（#113）

**改善**

- refactor(infra): synth スナップショットガードの追加とスタック合成の関数抽出（ADR-041）（#106）
- refactor: ADR-041 シリーズの簡素化とレビュー指摘の修正（#115）

**ドキュメント**

- docs(adr): ADR-041 マルチサイトデプロイ・ADR-042 マルチブランドビルドを追加（#61）
- docs: ADR-041 を承認済みへ変更しマルチサイトデプロイガイドを追加（#110）
- docs(site): マルチサイト運用ガイドを追加（#112）
- docs(site): LP にマルチサイトデプロイのスポットライトを追加（#114）

## [0.9.0] - 2026-07-18

**Highlights**

- **AI metadata suggestions are now generated per resource, in parallel.** Instead of one large LLM call that had to describe every file at once, each resource gets its own small completion and a final call integrates the results (ADR-040). This structurally removes the failure modes of small local models on large prompts, lets every file be judged with its full extracted material, raises the suggestion slots from 10 to 20 resources per dataset, and keeps the whole request inside a bounded time budget — a resource that fails or does not fit degrades to lightweight context instead of breaking the suggestion (#101).
- **Suggestions now cover categories and the URL identifier.** The integration step picks dataset categories from the site's existing groups only (the most-used 100 as candidates, with their descriptions; a dataset without a category gets a best-match pick), and proposes a URL slug for drafts, normalized and uniqueness-checked server-side. Tag and category suggestions are additions-only — adopting can never remove an existing value — and adopted dataset fields are saved immediately without a separate save step. The per-user limit was raised from 20 to 60 suggestions per hour to support regenerating a few times and picking the best result (#101).

**Features**

- feat(api): per-resource parallel metadata suggestions with category and URL slug (ADR-040) (#101)

**Improvements**

- chore(infra): enable CodePipeline V2 pipeline type via CDK feature flag (#102)

**Documentation**

- docs(adr): switch metadata suggestions to per-resource parallel generation (ADR-040 addendum) (#100)

---

**ハイライト**

- **AI メタデータ提案がリソース単位の並列生成になりました。** 全ファイルを 1 回の大きな LLM 呼び出しで記述する方式をやめ、リソースごとに小さな completion を並列実行し、最後に 1 回の統合呼び出しでデータセット全体をまとめます（ADR-040）。大きなプロンプトで起きていた小型ローカルモデルの破綻が構造的に解消され、各ファイルが自身の抽出素材をフルに使って記述されるようになり、提案対象は 1 データセットあたり 10 → 20 リソースに拡大しました。リクエスト全体は時間予算内に収まり、失敗・間に合わないリソースは提案を壊さず軽量コンテキストに降格します（#101）。
- **カテゴリーと URL 識別子も提案対象になりました。** 統合ステップがサイトの既存グループ（使用数上位 100 件を説明付き候補として提示、カテゴリー未設定のデータセットには最適 1 件を要求）からカテゴリーを選び、下書きには正規化・一意性確認済みの URL スラッグを提案します。タグ・カテゴリーの提案は追加専用で、採用によって既存の値が削除されることはありません。採用したデータセット側フィールドは保存ボタンなしでその場で保存されます。「何度か生成させて良いものを選ぶ」使い方に合わせ、ユーザーあたりの利用上限を 20 → 60 回/時に緩和しました（#101）。

**機能**

- feat(api): リソース単位の並列メタデータ提案とカテゴリー・URL スラッグ対応（ADR-040）（#101）

**改善**

- chore(infra): CDK フィーチャーフラグで CodePipeline V2 パイプラインタイプを有効化（#102）

**ドキュメント**

- docs(adr): メタデータ提案をリソース単位並列生成へ切り替え（ADR-040 追記）（#100）

## [0.8.6] - 2026-07-16

**Highlights**

- **AI metadata suggestions now wait until every resource finishes processing.** Previously the "Suggest metadata with AI" button and its nudge activated as soon as a single resource completed, so a suggestion could be generated while other resources were still uploading or being extracted — and silently leave them out. The button and nudge now activate only after all pipelines settle (including error endings). The gate closes before any request that starts a new pipeline is sent, and list-refresh and publish race conditions that could freeze the gate or roll statuses backwards were hardened away (#96).
- **Brand customization now has a token operation policy.** The appearance customization guide rates every CSS token — Recommended / Caution / Not recommended — together with its main usage locations and states (e.g. `--accent` drives button hover and dropdown selection), so deciding whether an override is safe no longer requires reading the source. Forks also get an official `--brand-*` namespace for designer-specified colors that fit no official token role, and component-scoped alias tokens can be added on demand to recolor a single upstream component without side effects (ADR-023) (#97).

**Features**

- feat(web): gate AI metadata suggestions until all resource processing settles (#96)

**Documentation**

- docs: define brand token operation policy and add override ratings (ADR-023) (#97)
- docs: note small local models are underpowered for AI metadata suggestion (#95)

**Improvements**

- ci: retry public mirror pushes on transient failures (#94)

---

**ハイライト**

- **AI メタデータ提案が、すべてのリソース処理の完了を待つようになりました。** 従来は 1 件のリソースが完了した時点で「AI にメタデータを提案させる」ボタンとナッジが活性化し、他のリソースがまだアップロード・抽出中でも提案が生成でき、それらが提案から漏れてしまうことがありました。すべてのパイプラインが終了（エラー終了を含む）してから活性化するようになり、パイプラインを起動する操作はリクエスト送信前からゲートを閉じ、リスト再取得や公開操作との競合でゲートが固まる・ステータスが巻き戻る問題も解消しています（#96）。
- **ブランドカスタマイズにトークン運用ポリシーが定義されました。** 外観カスタマイズガイドの CSS トークン表に上書き区分（推奨 / 注意 / 非推奨）と主な使用箇所・状態（例: `--accent` はボタンのホバーやドロップダウンの選択状態に波及）を明記し、上書き可否の判断にソースコードの調査が不要になりました。公式トークンの役割に当てはまらない独自色のためにフォーク専用の `--brand-*` 名前空間を新設し、本体画面の特定コンポーネントだけを安全に変えるためのエイリアストークンを需要ベースで追加する運用も定めています（ADR-023）（#97）。

**機能**

- feat(web): AI メタデータ提案の活性化をすべてのリソース処理の完了後に変更（#96）

**ドキュメント**

- docs: ブランドトークン運用ポリシーと上書き区分を定義（ADR-023）（#97）
- docs: 小型ローカルモデルは AI メタデータ提案には性能不足である旨を記載（#95）

**改善**

- ci: 公開ミラーへの push を一時的な障害発生時にリトライ（#94）

## [0.8.5] - 2026-07-15

**Highlights**

- **AI metadata suggestions now read PDF and Office documents and ZIP archives.** The pipeline persists the head of the text it already extracts from documents (PDF / DOCX / XLSX / PPTX / ODT / ODP / ODS / RTF) as a small storage artifact, and the suggestion API uses it — together with ZIP file listings — as generation material, with no extra download or parsing at suggestion time. This also works while a dataset is still a draft, where suggestions matter most: drafts now produce the artifact during editing, while their content continues to stay out of the search index until publish (ADR-040) (#89).
- **Suggestions describe each resource first, then summarize the dataset.** The model now writes each resource's name and description independently from that resource's own material, and only then writes the dataset title, description, and tags as an integration of those descriptions — so a single file no longer dominates a dataset that mixes resources of different natures. Guardrails for small local models were added as well: the opening lines of a document (usually its own title) outweigh recurring body themes, and proper nouns that appear nowhere in the material are not invented (#91).

**Features**

- feat: add PDF/Office/ZIP content materials to AI metadata suggestions (ADR-040) (#89)
- feat(api): generate resource suggestions before dataset metadata (ADR-040) (#91)

**Bug Fixes**

- fix(web): pipeline status badges no longer stick on "queued" / "processing" when bulk-uploaded resources finish processing between polls — the badge now trusts the fresher status delivered by the list refresh (#90)

**Documentation**

- docs(adr): promote PDF/Office/ZIP content materials to ADR-040 implementation (#88)
- docs: spotlight AI metadata suggestions on the landing page (#92)

---

**ハイライト**

- **AI メタデータ提案が PDF・Office 文書・ZIP アーカイブの内容を読めるようになりました。** パイプラインが文書（PDF / DOCX / XLSX / PPTX / ODT / ODP / ODS / RTF）から抽出済みのテキストの先頭を小さな成果物として Storage に保存し、提案 API はそれと ZIP のファイル一覧を生成素材として使います。提案時の追加ダウンロードやパースはありません。提案が最も活きる下書き編集中のデータセットでも成果物が生成されます（下書きの内容が公開まで検索に出ない挙動は従来どおりです）（ADR-040）（#89）。
- **提案は「各リソースを先に記述してからデータセットを統合する」順で生成されます。** 各リソースの名前・説明をそのリソース自身の素材から独立に記述した後で、データセットのタイトル・説明・タグをその統合として書くため、性質の異なるリソースが混在するデータセットで 1 つのファイルの内容が全体を支配しなくなりました。小型ローカルモデル向けのガードレールも追加しています: 文書の冒頭行（多くは文書自身のタイトル）を本文の頻出テーマより重視し、素材のどこにも現れない固有名詞を発明しません（#91）。

**機能**

- feat: AI メタデータ提案に PDF/Office/ZIP のコンテンツ素材を追加（ADR-040）（#89）
- feat(api): リソースの提案をデータセットのメタデータより先に生成（ADR-040）（#91）

**バグ修正**

- fix(web): 一括アップロード時にパイプラインステータスが「待機中」「処理中」のまま固まることがある問題を修正しました。ポーリングの合間に処理が完了した場合でも、リスト再取得が持つ新しいステータスが表示されます（#90）

**ドキュメント**

- docs(adr): PDF/Office/ZIP コンテンツ素材対応を ADR-040 の実装に格上げ（#88）
- docs: ランディングページで AI メタデータ提案を紹介（#92）

## [0.8.4] - 2026-07-15

**Highlights**

- **Create a dataset by just dropping files.** The new-dataset page now accepts drag & drop: dropping files immediately creates a draft and carries the files over to the edit page, where each one becomes a resource and uploads automatically — no form filling required before you have somewhere to put your data (ADR-039) (#78).
- **Add resources by dropping files on the dataset edit page.** Files dropped anywhere on the resource list become resources and upload in parallel, keeping their drop order as the resource order. Oversized files (over the 100 MB upload limit) are reported per file without interrupting the rest, and the format is auto-detected from the file name (#77).
- **An accessibility sweep across the web UI.** Error and success callouts are now announced to screen readers, form validation errors are read together with the field they belong to, and icon-only buttons have accessible names (#83, #84, #85).

**Features**

- feat(web): add drag-and-drop resource creation to dataset edit page (#77)
- feat(web): create dataset drafts by dropping files on the new-dataset page (#78)

**Accessibility**

- Error callouts across the app now use one alert component: errors and urgent warnings are announced assertively (`role="alert"`), success and completion notes politely (`role="status"`), following WAI-ARIA guidance (#83).
- Form validation messages are wired to their inputs with `aria-describedby`, so screen readers read the error together with the field — on sign-in, sign-up, dataset, organization, group, announcement, and admin user forms (#85).
- Icon-only buttons (language switcher, pipeline-status dialog) received accessible names, the pipeline-status dialog gained a description, and the resource preview's loading state is announced while it loads (#84).

**Improvements**

- Status colors (success, warning, search highlight) are now semantic theme tokens instead of hardcoded palette values, so brand forks can retheme them from the brand override layer. The appearance customization guide and the `brand/theme.css` template document the new tokens (`--success-tint-foreground`, `--warning-tint-foreground`, `--highlight`) (#86).

---

**ハイライト**

- **ファイルをドロップするだけでデータセットを作成できるようになりました。** データセット新規作成ページがドラッグ＆ドロップに対応し、ファイルを落とすと即座に下書きが作られ、そのまま編集ページに引き継がれて各ファイルがリソースとして自動アップロードされます。データの置き場所を作るためにフォーム入力を済ませる必要はもうありません（ADR-039）（#78）。
- **データセット編集ページへのファイルドロップでリソースを追加できます。** リソース一覧のどこにドロップしてもファイルがリソースになり、並行アップロードされ、ドロップした順番がそのままリソースの並び順になります。上限（100 MB）を超えるファイルはファイル単位でエラー表示され、他のファイルの処理は中断されません。フォーマットはファイル名から自動判定されます（#77）。
- **Web UI 全体のアクセシビリティ改善。** エラー・成功の通知がスクリーンリーダーに読み上げられ、フォームのバリデーションエラーは対象フィールドとともに読み上げられ、アイコンのみのボタンにアクセシブルな名前が付きました（#83、#84、#85）。

**機能**

- feat(web): データセット編集ページにドラッグ＆ドロップでのリソース作成を追加（#77）
- feat(web): 新規作成ページへのファイルドロップでデータセット下書きを作成（#78）

**アクセシビリティ**

- アプリ全体のエラー表示を1つのアラートコンポーネントに統一しました。エラーや即時性のある警告は assertive（`role="alert"`）、成功・完了の通知は polite（`role="status"`）に読み上げられます（WAI-ARIA 準拠）（#83）。
- フォームのバリデーションメッセージを `aria-describedby` で入力欄に紐付け、スクリーンリーダーがエラーをフィールドとともに読み上げるようにしました — サインイン・サインアップ・データセット・組織・カテゴリ・お知らせ・管理者ユーザーの各フォームが対象です（#85）。
- アイコンのみのボタン（言語切替、パイプライン状態ダイアログ）にアクセシブルな名前を付け、パイプライン状態ダイアログに説明文を追加し、リソースプレビューの読み込み中状態が読み上げられるようにしました（#84）。

**改善**

- 状態色（成功・警告・検索ハイライト）をハードコードされたパレット値からセマンティックなテーマトークンに置き換え、ブランドフォークがブランドオーバーライドレイヤーから配色を変更できるようにしました。外観カスタマイズガイドと `brand/theme.css` テンプレートに新トークン（`--success-tint-foreground`・`--warning-tint-foreground`・`--highlight`）を記載しています（#86）。

## [0.8.3] - 2026-07-14

**Breaking Changes**

- The `BEDROCK_COMPLETION_MODELS` environment variable has been renamed to `AI_COMPLETION_MODELS`. AWS deployments pick this up automatically on redeploy (CDK injects the variable together with the matching IAM grants); only deployments that set the variable by hand need to rename it (#75).
- The admin model picker for Ollama and OpenAI-compatible providers no longer enumerates the models available on the server. The options now come from the `AI_COMPLETION_MODELS` allow-list (comma-separated; the first entry is the provider default). If you previously switched between several pulled models, list them in `AI_COMPLETION_MODELS`; when unset, only the built-in default is offered (Ollama: gemma4:e4b / OpenAI-compatible: gpt-4o-mini) (#75).

**Highlights**

- **One allow-list now drives the completion-model choices on every provider.** `AI_COMPLETION_MODELS` is the list of models the deployment has approved for use: it becomes the admin picker options as-is, with the first entry as the default. Models merely available on the server are not offered — being pulled is not the same as being approved. On Bedrock the task role is granted `bedrock:InvokeModel` on exactly this list, and with Docker Compose `ollama-init` pulls every listed model at startup, so every picker option is actually runnable (#75).
- **The default Bedrock generation model is now Amazon Nova Lite** (`jp.amazon.nova-2-lite-v1:0`), applying ADR-040's rule of adopting the cheapest model that meets the quality bar. Claude models remain available by listing them in the deployment config, and the `jp.` inference profile keeps inference within Japan (#75).

**Improvements**

- A saved generation model that has been dropped from the allow-list now falls back to the provider default on every provider, not just Bedrock (#75).
- `cdk synth` now works from a clean checkout: the CDK app builds the shared workspace package it depends on before synthesizing (#75).
- Empty values injected by Docker Compose for optional AI variables (`${VAR:-}`) are treated as unset instead of empty model names (#75).

---

**破壊的変更**

- 環境変数 `BEDROCK_COMPLETION_MODELS` を `AI_COMPLETION_MODELS` に改名しました。AWS デプロイは再デプロイで自動的に追従します（CDK が IAM 付与とあわせてこの変数を注入します）。手動でこの変数を設定しているデプロイのみ改名が必要です（#75）。
- Ollama / OpenAI 互換プロバイダの管理画面モデルピッカーが、サーバー上の利用可能モデルを列挙しなくなりました。選択肢は `AI_COMPLETION_MODELS` の許可リスト（カンマ区切り・先頭が既定）から決まります。複数の pull 済みモデルを切り替えて使っていた場合は `AI_COMPLETION_MODELS` に列挙してください。未設定時は組み込み既定（Ollama: gemma4:e4b / OpenAI 互換: gpt-4o-mini）のみが候補になります（#75）。

**ハイライト**

- **1つの許可リストが全プロバイダの生成モデル選択を決めるようになりました。** `AI_COMPLETION_MODELS` は「このデプロイで利用を承認したモデルのリスト」で、そのまま管理画面ピッカーの選択肢になり、先頭エントリが既定です。サーバー上で利用可能なだけのモデルは候補に出ません — pull されていることと利用が承認されていることは別だからです。Bedrock ではタスクロールにこのリストちょうどの `bedrock:InvokeModel` が付与され、Docker Compose では `ollama-init` が列挙された全モデルを起動時に pull するため、ピッカーのどの選択肢も必ず実行できます（#75）。
- **Bedrock の既定生成モデルが Amazon Nova Lite**（`jp.amazon.nova-2-lite-v1:0`）になりました。ADR-040 の「品質基準を満たすモデルのうち最も低コストのものを採用する」ルールの適用です。Claude 系はデプロイ設定に列挙すれば引き続き利用でき、`jp.` 推論プロファイルにより推論は国内に留まります（#75）。

**改善**

- 許可リストから外れた保存済みの生成モデルが、Bedrock だけでなく全プロバイダでプロバイダ既定にフォールバックするようになりました（#75）。
- クリーンな checkout から `cdk synth` が動くようになりました。CDK アプリが依存する共有ワークスペースパッケージを synth 前に自動ビルドします（#75）。
- Docker Compose が optional な AI 変数に注入する空値（`${VAR:-}`）を、空のモデル名ではなく未設定として扱うようになりました（#75）。

## [0.8.2] - 2026-07-14

**Documentation**

- Updated the Bedrock model subscription guidance to match AWS's retired "Model access" console page. Serverless foundation models (Amazon Titan / Nova) now enable automatically on first invocation, and Marketplace-served models (such as Cohere Embed v4) are enabled account-wide when a user with AWS Marketplace permissions invokes them once. The system administrator guide's Bedrock troubleshooting table now points to a new step-by-step walkthrough for that one-time subscription — via the Bedrock model catalog playground or a single CLI `invoke-model` call — and the in-app connection-test hints were reworded to match (#73).

---

**ドキュメント**

- AWS で「Model access（モデルアクセス）」コンソールページが廃止されたことに合わせ、Bedrock のモデルサブスクライブ手順を更新しました。サーバーレス基盤モデル（Amazon Titan / Nova）は初回呼び出しで自動的に有効化され、Marketplace 提供モデル（Cohere Embed v4 など）は AWS Marketplace 権限を持つユーザーが一度呼び出すとアカウント全体で有効化されます。システム管理者ガイドの Bedrock トラブルシュート表から、この初回サブスクライブの手順（Bedrock モデルカタログの Playground、または CLI の `invoke-model` 1 コマンド）への段階的な案内を新設し、アプリ内の接続テストのヒント文言もこれに合わせて更新しました（#73）。

## [0.8.1] - 2026-07-13

**Highlights**

- **AI metadata suggestions are ready to run on AWS Bedrock.** The web service's task role is now granted `bedrock:InvokeModel` on exactly the completion models you list in your deployment config, and that same list becomes the model choices in the admin dashboard — so every option in the picker is guaranteed to be invokable. Cross-region inference profiles (`jp.`, `us.`, `eu.`, `apac.`, `global.`, and more) are handled automatically, and the `jp.` profiles keep inference inside Japan.
- **When the connection test fails, the admin dashboard now tells you what to fix** — a missing IAM grant, an unsubmitted Bedrock use-case form, or a missing AWS Marketplace subscription — instead of showing only a raw provider error. The system administrator guide gains a matching Bedrock troubleshooting table.

**Improvements**

- The admin AI settings are reorganized under a "Generative AI models" card, with metadata suggestions as one labeled section, so future AI uses of a completion model can pick their own model alongside it. The provider is shown once for the whole card (#71).
- The AI suggestion dialog no longer closes when you click outside it, and no longer reopens after you publish a draft, so an in-progress review is not lost by accident (Esc, the close button, and Cancel still work). The model selector was widened so long inference-profile IDs no longer wrap (#70).
- The generation model is chosen from your deployment's model list, with the first entry acting as the default; a saved model that is later removed from the list falls back to the default instead of failing at invocation (#70).

**Notes**

- No database migration. To roll this out on AWS, redeploy so the task role picks up the new IAM grant; the dashboard connection test then passes and the model dropdown is populated (ADR-040) (#70).

---

**ハイライト**

- **AI メタデータ提案が AWS Bedrock で動かせるようになりました。** web サービスのタスクロールに、デプロイ設定で列挙した生成モデルちょうどに対する `bedrock:InvokeModel` が付与され、その同じリストが管理画面のモデル選択肢になります。したがってドロップダウンのどの選択肢も必ず呼び出せます。クロスリージョン推論プロファイル（`jp.`・`us.`・`eu.`・`apac.`・`global.` ほか）は自動的に扱われ、`jp.` プロファイルは推論を国内に留めます。
- **接続テストが失敗したとき、管理画面が対処すべき内容を提示するようになりました** — IAM 未付与・Bedrock 利用ユースケースフォーム未提出・AWS Marketplace 未サブスクを、生のプロバイダエラーだけでなく判別して表示します。システム管理者ガイドにも Bedrock のトラブルシュート表を追加しました。

**改善**

- 管理画面の AI 設定を「生成AI利用モデル」カードに再構成し、メタデータ提案を見出し付きの1セクションにまとめました。今後、生成モデルを使う別の用途を並べて（用途ごとにモデルを選んで）追加できます。プロバイダはカードで一度だけ表示します（#71）。
- AI 提案ダイアログが枠外クリックで閉じなくなり、下書きの公開後に再度開くこともなくなりました。作業中のレビューを誤操作で失いません（Esc・閉じるボタン・キャンセルは従来どおり）。長い推論プロファイル ID が折り返さないようモデルセレクタの幅を広げました（#70）。
- 生成モデルはデプロイのモデルリストから選び、先頭の要素が既定として使われます。後からリストで外したモデルが保存されていても、呼び出し時に失敗せず既定へフォールバックします（#70）。

**メモ**

- データベースマイグレーションはありません。AWS へ反映するには、タスクロールが新しい IAM 付与を取り込むよう再デプロイしてください。その後、管理画面の接続テストが通り、モデルドロップダウンに候補が表示されます（ADR-040）（#70）。

## [0.8.0] - 2026-07-13

**Highlights**

- **AI metadata suggestions.** From the dataset edit page you can now ask an AI to draft a title, notes, tags, and a name and description for each resource, then adopt any field individually — every toggle is opt-in and each proposal can be edited inline before you apply it. Suggestions use the actual file contents for CSV/TSV and the filename for other formats, run on Bedrock, Ollama, or any OpenAI-compatible endpoint, and the generation model is switchable at runtime from the admin dashboard.
- **File-first draft datasets.** Datasets are now created as drafts: create the draft, upload and process resources, review previews, then publish. Drafts stay in your dashboard and never appear in search results or public listings until you publish them.

**Features**

- feat: AI metadata suggestions — on the edit page, generate a title, notes, tags, and per-resource name/description in one call, adopt them per field (all opt-in) with inline editing, and never persist a suggestion until it is adopted. Backed by a new `AIAdapter.complete()` across Bedrock / Ollama / OpenAI-compatible providers, with a per-user rate limit, an admin on/off kill switch, a connection test, and a runtime-switchable model chosen from a dropdown of the provider's available models (ADR-040) (#60, #62, #64, #65, #67).
- feat: file-first draft dataset creation — create a dataset as a draft, add and process resources with previews, then publish; drafts are dashboard-only and excluded from search and listings until published (ADR-039) (#58).

**Bug Fixes**

- fix: tags saved on a private draft no longer leak to the public tag list, the CKAN `tag_list` API, or the AI suggestion candidates — tags are counted over published datasets only, while controlled-vocabulary tags remain listed regardless of use. Adopting an AI resource suggestion now surfaces update failures instead of silently closing as if it succeeded, and the AI connection test verifies the model actually returns valid JSON rather than passing on any response (#68).

---

**ハイライト**

- **AI メタデータ提案。** データセットの編集画面から、タイトル・説明・タグ、および各リソースの名前・説明を AI に下書きさせ、フィールド単位で採用できるようになりました。採用トグルはすべてオプトインで、各提案は適用前にその場で編集できます。提案は CSV/TSV では実際のファイル内容を、その他の形式ではファイル名を材料にし、Bedrock・Ollama・OpenAI 互換エンドポイントで動作します。生成モデルは管理画面から再デプロイなしで切り替えられます。
- **ファイルファーストの下書きデータセット。** データセットは下書きとして作成するようになりました。下書きを作成 → リソースをアップロード・処理 → プレビュー確認 → 公開、という流れです。下書きは公開するまでダッシュボードにのみ表示され、検索結果や公開一覧には一切現れません。

**機能**

- feat: AI メタデータ提案 — 編集画面でタイトル・説明・タグ・各リソースの名前/説明を 1 回の呼び出しで生成し、フィールド単位（すべてオプトイン）でインライン編集しながら採用。提案は採用するまで永続化しません。Bedrock / Ollama / OpenAI 互換に対応する新しい `AIAdapter.complete()` を基盤に、ユーザー単位のレート制限・管理者のキルスイッチ・接続テスト・プロバイダの利用可能モデルから選ぶランタイム切替を備えます（ADR-040）（#60, #62, #64, #65, #67）。
- feat: ファイルファーストの下書き作成 — データセットを下書きとして作成し、プレビュー付きでリソースを追加・処理してから公開します。下書きは公開するまでダッシュボード限定で、検索・一覧から除外されます（ADR-039）（#58）。

**バグ修正**

- fix: 非公開の下書きに付けたタグが公開タグ一覧・CKAN `tag_list` API・AI 提案候補に漏洩する問題を修正しました。タグは公開済みデータセットのみで集計されるようになり、統制語彙タグは利用有無にかかわらず一覧に残ります。AI のリソース提案の採用は、失敗を隠して成功したかのように閉じるのではなくエラーを表示するようになり、AI 接続テストはどんな応答でも成功とせず、モデルが実際に有効な JSON を返すことを検証するようになりました（#68）。

## [0.7.6] - 2026-07-11

**Bug Fixes**

- Tags no longer linger after they are removed. Free tags are created on demand when added to a dataset, but the tag itself was never cleaned up once the last dataset stopped using it, so it stayed in the search filters forever as an unselectable zero-count entry. Unreferenced free tags are now deleted in the same transaction whenever tag links are removed — on dataset update, dataset purge, and organization purge. Controlled-vocabulary tags are not affected (#54).

---

**バグ修正**

- 外したタグが残り続ける問題を修正しました。自由タグはデータセットに付けたときに自動作成されますが、最後のデータセットから外されてもタグ自体は削除されず、検索フィルターに選択不能な「0件」表示のまま永久に残っていました。タグの紐付けが減る操作（データセット更新・データセット完全削除・組織完全削除）と同一トランザクション内で、どこからも参照されなくなった自由タグを削除するようになりました。統制語彙タグは対象外です（#54）。

## [0.7.5] - 2026-07-10

**Breaking Changes**

- The `REGISTRATION_ENABLED` environment variable has been removed. Self-registration is now a runtime setting managed from the admin dashboard (Site Management → User Self-Registration) and defaults to **disabled**. Deployments that ran with `REGISTRATION_ENABLED=true` must re-enable self-registration once from the admin dashboard after upgrading; no redeploy is needed for future changes (#51).

**Highlights**

- Setting up a fresh KUKAN no longer requires CLI or database access. While no users exist, self-registration is open and **the first registered user automatically becomes a system administrator** — deploy, open the sign-up page, and you are done. On internet-facing deployments, register the first user promptly after deploying; `pnpm db:create-user` remains available for headless setup and lockout recovery (#51).
- Self-registration can now be toggled at runtime from the admin dashboard, taking effect within about a minute — no redeploy, useful for opening registration temporarily or closing it immediately when needed (#51).

**Features**

- The first-user promotion is safe under concurrency and mid-setup crashes: it is decided by a one-shot claim backed by a database unique constraint, so exactly one sysadmin is created no matter how many sign-ups race for it. A first attempt that dies mid-creation self-heals after 60 seconds, and sign-ups arriving while a claim is in flight receive a retryable 409. The promotion is recorded in the audit log (#51).
- Creating a user from the admin dashboard now accepts a display name, matching the edit dialog — no more create-then-edit round trip (#51).

**Improvements**

- The admin site-management cards now behave consistently: every card's save button stays disabled until there is an actual change (#51).

---

**破壊的変更**

- 環境変数 `REGISTRATION_ENABLED` を廃止しました。自己登録の可否は管理画面（サイト管理 → ユーザー自己登録）のランタイム設定になり、既定は**無効**です。`REGISTRATION_ENABLED=true` で運用していた環境は、アップグレード後に管理画面で一度自己登録を有効化し直してください。以後の切り替えに再デプロイは不要です（#51）。

**ハイライト**

- 新規インストールのセットアップに CLI や DB アクセスが不要になりました。ユーザーが1人も存在しない間は自己登録が開放され、**最初に登録したユーザーが自動的にシステム管理者になります** — デプロイしてサインアップページを開くだけで初期設定が完了します。インターネット公開デプロイではデプロイ後すみやかに初回ユーザーを登録してください。`pnpm db:create-user` はヘッドレス初期化・ロックアウト回復用として引き続き利用できます（#51）。
- 自己登録の可否を管理画面からランタイムで切り替えられるようになりました（反映は約1分以内）。再デプロイ不要のため、期間限定の登録開放や問題発生時の即時クローズが容易になります（#51）。

**機能**

- 初回ユーザーの sysadmin 昇格は、同時アクセスやセットアップ途中のクラッシュに対して安全です。昇格はデータベースの一意制約に基づく one-shot claim で決定されるため、何件のサインアップが競合しても sysadmin はちょうど1人だけ作成されます。初回登録が途中で失敗した場合は60秒後に自動回復し、claim 進行中のサインアップにはリトライ可能な 409 を返します。昇格は監査ログに記録されます（#51）。
- 管理画面のユーザー作成ダイアログで表示名を入力できるようになりました。編集ダイアログと同等になり、「作成してから編集で表示名を付ける」手間がなくなります（#51）。

**改善**

- 管理画面のサイト管理カードの挙動を統一し、すべてのカードで変更がない間は保存ボタンが非アクティブになるようにしました（#51）。

## [0.7.4] - 2026-07-10

**Upgrade Notes**

- Existing AWS deployments: the next `cdk deploy` applies the new backup defaults for your `scale`. `medium` turns on S3 versioning and extends the database backup window to 14 days; `large` additionally creates an AWS Backup vault with daily and monthly snapshots. Both add storage/backup cost. To keep the previous behavior, pin the values via `overrides.backup` (e.g. `{ s3Versioning: false, dbBackupRetentionDays: 1, awsBackup: false }`). `small` deployments only see the database backup window grow from the CDK default of 1 day to 7 days.
- Forks that edited upstream test files to work around brand-related test failures will hit merge conflicts in those files when pulling this release. Resolve them by taking the upstream version as-is — upstream tests are now pinned to the KUKAN default brand and pass regardless of your customizations. Move any fork-specific assertions to `apps/web/src/brand/__tests__/` instead (see the new Testing section of the brand customization guide).

**Highlights**

- AWS deployments now get a scale-driven backup strategy out of the box (ADR-037). Database point-in-time recovery windows, S3 object versioning, and — on `large` — an isolated AWS Backup vault with daily and monthly snapshots are all derived from the existing `scale` setting, with per-value fine-tuning available through `overrides.backup` (#48).
- Friendlier fork operations: upstream unit tests are now pinned to the KUKAN default brand, so customizing `src/brand/` no longer breaks upstream CI in forks (#49).

**Features**

- Scale presets now include backup defaults: `small` keeps 7 days of database point-in-time recovery; `medium` adds S3 versioning (delete/overwrite protection) and a 14-day database window; `large` extends the window to 35 days and adds an AWS Backup plan — daily snapshots kept 35 days and monthly snapshots kept 12 months — in an isolated vault (#48).
- Noncurrent S3 object versions expire after 30 days by default, bounding the storage cost of versioning. Invalid combinations are rejected at synth time, such as enabling AWS Backup without S3 versioning or a database retention outside the 1–35 day RDS/Aurora limit (#48).

**Improvements**

- Upstream unit tests mock the brand layer to the KUKAN defaults, and a new slot test verifies that `Header` / `Footer` / `TopPage` overrides take precedence over the default components. Forks place tests for their custom components in `apps/web/src/brand/__tests__/` (discovered automatically); the testing strategy is documented in ADR-023 and the brand customization guide (#49).

---

**アップグレード時の注意**

- 既存の AWS デプロイでは、次回の `cdk deploy` で `scale` に応じた新しいバックアップデフォルトが適用されます。`medium` は S3 バージョニングが有効になり DB バックアップ保持が 14 日に、`large` はさらに日次・月次スナップショットを保存する AWS Backup ボールトが作成されます。いずれもストレージ・バックアップ費用が増加します。従来の挙動を維持したい場合は `overrides.backup` で明示的に固定してください（例: `{ s3Versioning: false, dbBackupRetentionDays: 1, awsBackup: false }`）。`small` は DB バックアップ保持が CDK デフォルトの 1 日から 7 日に延びるのみです。
- ブランド起因のテスト失敗を回避するために本体のテストファイルを書き換えていたフォークでは、本リリースの取り込み時に該当ファイルがコンフリクトします。本体側の内容をそのまま採用して解決してください — 本体テストは KUKAN デフォルトブランドに固定されたため、カスタマイズ内容に関係なくパスするようになります。フォーク独自のアサーションは `apps/web/src/brand/__tests__/` に移してください（ブランドカスタマイズガイドに新設した「テスト」節を参照）。

**ハイライト**

- AWS デプロイに、スケール連動のバックアップ戦略が標準搭載されました（ADR-037）。データベースのポイントインタイムリカバリ期間、S3 オブジェクトバージョニング、`large` では隔離ボールトへの日次・月次スナップショット（AWS Backup）が、既存の `scale` 設定から自動的に導出されます。各値は `overrides.backup` で個別調整できます（#48）。
- フォーク運用がより安全に: 本体のユニットテストが KUKAN デフォルトブランドに固定されるようになり、`src/brand/` をカスタマイズしてもフォークの CI で本体テストが壊れなくなりました（#49）。

**機能**

- スケールプリセットにバックアップデフォルトを追加: `small` は DB のポイントインタイムリカバリ 7 日、`medium` は S3 バージョニング（削除・上書き保護）+ DB 14 日、`large` は DB 35 日 + AWS Backup プラン（日次スナップショット 35 日保持・月次 12 ヶ月保持）を隔離ボールトに保存（#48）。
- S3 の非カレントバージョンはデフォルト 30 日で失効し、バージョニングのストレージコストを抑制。S3 バージョニングなしでの AWS Backup 有効化や、RDS/Aurora の上限（1〜35 日）を外れた DB 保持日数などの不正な組み合わせは synth 時にエラーになります（#48）。

**改善**

- 本体のユニットテストがブランドレイヤーを KUKAN デフォルトにモックするようになり、`Header` / `Footer` / `TopPage` のオーバーライドがデフォルトより優先されることを検証するスロットテストを追加。フォーク独自コンポーネントのテストは `apps/web/src/brand/__tests__/` に置けば自動検出されます。テスト戦略は ADR-023 とブランドカスタマイズガイドに記載（#49）。

## [0.7.3] - 2026-07-08

Documentation-only patch release. No code changes.

**Documentation**

- The `environments.ts` sample in the system administrator guide (English / Japanese) now uses a consistent multi-line format for every environment entry — the `prd` entry was previously collapsed onto a single line (#46).

---

**ドキュメント**

- システム管理者ガイド（日英）の `environments.ts` サンプルで、1行に潰れていた `prd` エントリを他のエントリと同じ複数行フォーマットに統一（#46）。

## [0.7.2] - 2026-07-08

**Breaking Changes**

- **`brandConfig.searchExampleQueries` was removed** (#44). The example-query chips under the search box are now managed at runtime from the admin UI instead of the fork-side brand config. When upgrading a fork that sets this field: delete the `searchExampleQueries` line from `apps/web/src/brand/brand-config.ts` (the build fails until it is removed), then re-enter the queries in **Dashboard → Site Management → Example Search Queries**. Values are not migrated automatically.

**Upgrade Notes**

- Run database migrations after upgrading — this release adds a `system_setting` table (additive only; no changes to existing tables).
- `docker compose up` now starts the Ollama container as part of the default stack (it previously required `--profile ai`). With `AI_TYPE=ollama`, a one-shot `ollama-init` container downloads the embedding model (~1.2 GB) automatically on first start; it skips the registry entirely when the model volume is pre-distributed (closed networks). With other `AI_TYPE` values it exits immediately without downloading anything.

**Highlights**

- Sysadmins can now tune search behavior from the admin UI without a redeploy. A new **Site Management** page section controls three runtime settings: a semantic-search on/off switch, a similarity-threshold adjustment, and the example-query chips. Changes propagate to all instances within 30 seconds and every change is recorded in the audit log (#44).

**Features**

- DB-backed runtime settings foundation: a registry of settings (key + validation schema + default) backed by a `system_setting` table, exposed through a generic sysadmin API (`GET /api/v1/admin/settings`, `PUT /api/v1/admin/settings/:key`). Adding a future setting requires no new endpoint (#44).
- Semantic search kill switch: turning it off degrades all searches to keyword-only, skips query embedding entirely (no provider cost), and hides the semantic affordances in the search UI — the "include related results" toggle and the natural-language search placeholder. The same UI adjustments apply automatically on deployments without an embedding provider (`AI_TYPE=none`) (#44).
- Similarity-threshold adjustment: the vector-search similarity floor can be shifted ±4 notches of 0.025 around the model's measured baseline. The offset is stored relative to the baseline, so it remains meaningful when the embedding model changes; a golden-set sweep on bge-m3 measured overall nDCG@10 improving from 82% to 85% at −2 notches (#44).
- Example-query chips are now editable from the admin UI, so operators can keep them aligned with the catalog's actual content (#44).

---

**破壊的変更**

- **`brandConfig.searchExampleQueries` を削除**（#44）。検索ボックス下のクエリ例チップは、フォーク側ブランド設定ではなく管理画面からランタイムに管理する方式に変更。このフィールドを設定しているフォークをアップグレードする場合: `apps/web/src/brand/brand-config.ts` から `searchExampleQueries` 行を削除し（削除するまでビルドが失敗します）、**ダッシュボード → サイト管理 → 検索例クエリ** に値を入れ直してください。値の自動移行は行われません。

**アップグレード時の注意**

- アップグレード後にデータベースマイグレーションを実行してください — 本リリースで `system_setting` テーブルが追加されます（追加のみ。既存テーブルへの変更はありません）。
- `docker compose up` がデフォルトスタックの一部として Ollama コンテナを起動するようになりました（従来は `--profile ai` が必要）。`AI_TYPE=ollama` の場合、ワンショットの `ollama-init` コンテナが初回起動時に埋め込みモデル（約1.2GB）を自動ダウンロードします。モデルボリュームを事前配布している閉域網ではレジストリに接続せずスキップします。その他の `AI_TYPE` では何もダウンロードせず即終了します。

**ハイライト**

- 再デプロイなしで検索の挙動を管理画面から調整できるようになりました。**サイト管理**ページに、意味検索のオン/オフ・類似度しきい値の調整・検索例クエリの3つのランタイム設定が追加されています。変更は30秒以内に全インスタンスへ伝播し、すべての変更が監査ログに記録されます（#44）。

**機能**

- DB バックエンドのランタイム設定基盤: 設定のレジストリ（キー + 検証スキーマ + 既定値）を `system_setting` テーブルで永続化し、汎用の sysadmin API（`GET /api/v1/admin/settings`、`PUT /api/v1/admin/settings/:key`）で公開。今後の設定追加にエンドポイントの追加は不要です（#44）。
- 意味検索のキルスイッチ: オフにするとすべての検索がキーワード検索のみに退避し、クエリ埋め込み自体をスキップ（プロバイダ課金なし）。検索 UI の「意味の近い結果を含める」トグルと自然文プレースホルダーも非表示になります。埋め込みプロバイダのないデプロイ（`AI_TYPE=none`）でも同じ UI 調整が自動で適用されます（#44）。
- 類似度しきい値の調整: ベクトル検索の類似度下限を、モデル実測の基準値から ±4目盛り（1目盛り 0.025）で調整可能。オフセットとして保存されるためモデル変更後も意味が保たれます。bge-m3 のゴールデンセット評価では −2目盛りで overall nDCG@10 が 82% → 85% に改善（#44）。
- 検索例クエリを管理画面から編集可能に。カタログの実データに合わせて運用中に育てられます（#44）。

## [0.7.1] - 2026-07-07

Documentation-only patch release. No code changes.

**Documentation**

- The `.env` examples no longer suggest an OpenSearch heap below the compose default of 2g — copying the old values could reintroduce the circuit-breaker failures fixed in 0.7.0 (#41).
- Release notes in CHANGELOG.md are no longer hard-wrapped, fixing forced mid-sentence line breaks in GitHub Releases (#40).
- The landing page feature cards now describe the implemented semantic search and MCP SQL queries, with all cards aligned to a uniform length (#42).

---

**ドキュメント**

- `.env` の example が compose デフォルト（2g）を下回る OpenSearch ヒープ値を提案しないように修正。旧値をコピーすると 0.7.0 で修正したサーキットブレーカー問題が再発するため（#41）。
- CHANGELOG.md の折り返しを解除し、GitHub Release 本文で文の途中に強制改行が入る問題を修正（#40）。
- ランディングページの機能カードを、実装済みのセマンティック検索・MCP 経由 SQL クエリを反映した内容に更新し、全カードの分量を統一（#42）。

## [0.7.0] - 2026-07-07

The first tagged release of KUKAN. Earlier trial deployments tracked the `main` branch; from this release on, use release tags (`vX.Y.Z`) and check this file before upgrading.

**Breaking Changes**

- **The PostgreSQL container image changed from `postgres:16-alpine` to `pgvector/pgvector:pg16`** (#23). Database migrations now run `CREATE EXTENSION vector`, which fails on images without pgvector. When upgrading an existing Docker Compose deployment:
  - Development: recreate the `pgdata` volume (`docker compose down -v`).
  - Production: dump with `pg_dump` on the old container, restore on the new one. Reusing the volume as-is is not safe — the Alpine → Debian switch changes the collation implementation, which can silently corrupt indexes.

**Upgrade Notes**

- The local / on-premises OpenSearch heap default was raised from 512m to 2g to prevent circuit-breaker failures under load (#31). Ensure the host has enough RAM, or override via `OPENSEARCH_JAVA_OPTS`.
- AWS deployments now enable semantic search via Amazon Bedrock by default (Titan Text Embeddings v2). This adds Bedrock IAM permissions and per-invocation cost. Opt out with `bedrock: false` in `infra/config/environments.ts` (#36). **Cohere Embed v4 is the recommended model** — measurably stronger Japanese retrieval than the Titan default (nDCG 75 vs 70 on our golden set, +5–12pt on question-form queries). Set `bedrock: { embeddingModel: 'cohere.embed-v4:0' }`; it requires a one-time Marketplace subscription invoke (#37).
- After upgrading, rebuild the search index (`POST /api/v1/admin/reindex-metadata`) to populate embeddings and updated mappings.

**Highlights**

- **Semantic search over dataset metadata** (ADR-034): hybrid BM25 + vector search with RRF fusion (#25), natural-language queries in the search UI (#32), and a semantic match badge with an opt-out toggle (#26). Embeddings run on Bedrock (Titan v2 / Cohere Embed v4), Ollama (bge-m3), or OpenAI, with per-model similarity floors (#22, #27, #37) and a golden-set evaluation script (`pnpm eval:search`, #29).
- **Server-side data queries** (ADR-032): resource column schemas are persisted and exposed (#8), and resources can be queried with SQL through server-side DuckDB (#13) — the foundation for MCP-based data access by AI agents.
- **Multi-environment AWS deployment**: CDK Pipelines deploy each environment (dev / prd) from branch pushes via CodeConnections, on a CloudFront → internal ALB → ECS Fargate architecture (ADR-027 / ADR-030 / ADR-031).
- Everything the beta already shipped: dataset / organization / group catalog with a CKAN-compatible API, resource pipeline with format-aware previews (CSV/TSV tables, GeoJSON maps, PDF, Office, images), full-text search (OpenSearch with kuromoji, PostgreSQL fallback), DuckDB-WASM data explorer, GA4 analytics, brand customization, and on-premises Docker Compose deployment for air-gapped networks.

**Bug Fixes (notable)**

- Search returns 503 instead of silently showing zero results during an OpenSearch outage (#11).
- Hybrid search pagination stays consistent past the RRF fusion window (#35).
- Japanese request boilerplate (e.g. 「〜を教えてください」) is stripped from metadata queries before embedding (#34).
- Docker images: DuckDB crash on Alpine fixed and HIGH CVEs eliminated (#14, #15, #16); on-premises Docker Compose startup repaired (#17).

---

**破壊的変更**

- **PostgreSQL コンテナイメージを `postgres:16-alpine` から `pgvector/pgvector:pg16` に変更しました**（#23）。マイグレーションが `CREATE EXTENSION vector` を実行するため、pgvector を含まないイメージでは失敗します。既存の Docker Compose 環境をアップグレードする場合:
  - 開発環境: `pgdata` ボリュームを再作成（`docker compose down -v`）。
  - 本番環境: 旧コンテナで `pg_dump` → 新コンテナへリストア。Alpine → Debian の変更で照合順序（collation）の実装が変わるため、ボリュームの流用はインデックス破損の危険があり安全ではありません。

**アップグレード時の注意**

- ローカル / オンプレミスの OpenSearch ヒープのデフォルトを 512m から 2g に引き上げました（負荷時のサーキットブレーカー発動対策、#31）。ホストのメモリを確認するか、`OPENSEARCH_JAVA_OPTS` で上書きしてください。
- AWS デプロイでは Amazon Bedrock によるセマンティック検索がデフォルトで有効になります（Titan Text Embeddings v2）。Bedrock の IAM 権限と呼び出しコストが発生します。無効化は `infra/config/environments.ts` で `bedrock: false`（#36）。**推奨モデルは Cohere Embed v4** です — デフォルトの Titan より日本語検索が計測上優れています（ゴールデンセットで nDCG 75 対 70、質問文クエリで +5〜12pt）。`bedrock: { embeddingModel: 'cohere.embed-v4:0' }` で指定し、初回のみ Marketplace 購読のための invoke が必要です（#37）。
- アップグレード後は検索インデックスの再構築（`POST /api/v1/admin/reindex-metadata`）を実行し、埋め込みと新しいマッピングを反映してください。

**ハイライト**

- **メタデータのセマンティック検索**（ADR-034）: BM25 + ベクトルのハイブリッド検索（RRF 融合、#25）、検索 UI での自然文クエリ対応（#32）、セマンティックマッチバッジと OFF トグル（#26）。埋め込みは Bedrock（Titan v2 / Cohere Embed v4）、Ollama（bge-m3）、OpenAI に対応し、モデル別の類似度しきい値（#22, #27, #37）とゴールデンセット評価スクリプト（`pnpm eval:search`、#29）を備えます。
- **サーバーサイドのデータクエリ**（ADR-032）: リソースの列スキーマを永続化・公開し（#8）、サーバーサイド DuckDB で SQL クエリが可能に（#13）。AI エージェントによる MCP 経由のデータアクセスの基盤です。
- **マルチ環境 AWS デプロイ**: CDK Pipelines + CodeConnections でブランチ push を起点に各環境（dev / prd）を自動デプロイ。CloudFront → 内部 ALB → ECS Fargate 構成（ADR-027 / ADR-030 / ADR-031）。
- ベータで提供済みの機能一式: データセット / 組織 / グループのカタログ管理と CKAN 互換 API、フォーマット別プレビュー付きリソースパイプライン（CSV/TSV テーブル、GeoJSON 地図、PDF、Office、画像）、全文検索（OpenSearch + kuromoji、PostgreSQL フォールバック）、DuckDB-WASM データエクスプローラー、GA4 アクセス統計、ブランドカスタマイズ、閉域網向け Docker Compose オンプレミスデプロイ。

**主なバグ修正**

- OpenSearch 障害時に 0 件表示ではなく 503 を返すように（#11）。
- ハイブリッド検索のページネーションが RRF 融合ウィンドウを越えても一貫するように（#35）。
- 「〜を教えてください」等の日本語定型句を埋め込み前にクエリから除去（#34）。
- Docker イメージ: Alpine での DuckDB クラッシュ修正と HIGH CVE の解消（#14, #15, #16）、オンプレ Docker Compose の起動不具合修正（#17）。
