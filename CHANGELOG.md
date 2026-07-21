# Changelog

All notable changes to KUKAN are documented in this file (English / 日本語).
This project adheres to [Semantic Versioning](https://semver.org/).

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
