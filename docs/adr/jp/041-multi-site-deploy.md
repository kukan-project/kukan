# ADR-041: マルチサイトデプロイ（共用インフラ + サイト単位の論理分離）

## ステータス

**承認済み（Accepted）** — 2026-07-19 実装（PR #106〜#109）。ADR-031（マルチ環境デプロイ）を置換せず**拡張**する。環境軸（dev / prd）の内側にサイト軸を追加する。

実装時の確定事項（本文からの差分）:

- 共有の箱に **Secrets Manager interface VPC endpoint** を追加（VPC に NAT が
  ないため、サイト DB 作成 Lambda の唯一の到達経路。サイト数によらず env あたり 1 つ）
- サイトドメインの ACM 証明書 / WAF WebACL は **standalone モードでは GlobalStack が
  自動作成**する（サイトごとの証明書 + サイト間共有の WebACL。pipeline モードは
  シングルサイトと同じく ARN 貼り付け必須 — cross-region 参照が CDK Pipelines と
  非互換のため、ADR-030。当初は両モードとも ARN 必須だったが 2026-07-20 に緩和）
- `OPENSEARCH_INDEX_PREFIX` の値は `kukan-<env>-<site>`（インデックスは
  `kukan-<env>-<site>-search`）
- **AWS Backup はマルチサイトでも使用可能**。DB プランは SharedStack（共有クラスタを
  1 回だけスナップショット）、バケットプランは各 SiteStack（vault
  `kukan-<env>-<site>-backup`）に分割する（当初は「共有クラスタがサイト数分
  スナップショットされる」ため使用不可としていたが 2026-07-20 に分割で解消）
- サイト DB/ロールは SiteStack 削除時も**残す**（Custom Resource の Delete は
  no-op。失敗 create のロールバック削除からデータを守る）
- サイトスタックのデプロイは**直列**（カナリア → 以降 1 サイトずつ。ECS の
  ローリング更新は新旧タスクを併走させるため、接続数バジェットが「同時更新は
  1 サイト」を前提に 1 サイト分の倍化を計上する。Wave 並列化は接続予算を
  複数サイト分確保できる場合の将来最適化）
- **`db.maxAcu` の引き上げとサイト追加は同一デプロイにしない**: max_connections
  は静的パラメータで、maxACU 変更後も全 DB インスタンスを再起動するまで旧値の
  まま。「ACU 変更のみを先にデプロイ → 全インスタンス再起動 → in-sync 確認 →
  サイト追加」の二段階とする（synth エラーの対処文にも明記）

## コンテキスト

1 つのフォークが複数の KUKAN サイト（例: 複数自治体のデータカタログ）を運用するケースでは、現状の「1 サイト = 1 環境 = 1 スタック全部入り」構成だと固定費がサイト数に比例して増える。固定費の主因は次の 2 つ。

- **OpenSearch ドメイン**: ノード時間課金（small: t3.small.search ×1、medium: m6g.large.search ×1）
- **Aurora 最小 ACU**: アイドル時も `serverlessV2MinCapacity` 分が課金される

一方、サイトのデータと名前空間を持つ論理リソース（DB、インデックス、バケット、キュー）は分離したままにできる。KUKAN のアプリ層は以下の点で既にサイト分離に必要な下地を持つ。

- PostgreSQL 接続は `POSTGRES_DB` 環境変数で対象 DB を切替可能（`packages/shared/src/env.ts`）
- OpenSearch アダプターは `indexPrefix` オプションを持つ（`packages/adapters/search/src/opensearch.ts`。ただし現状 `packages/api/src/adapters.ts` は既定値 `kukan` のまま渡していない）
- ユーザー・セッション・組織・ランタイム設定（ADR-036）はすべて DB 内にあり、DB を分ければ自動的にサイト別になる
- Worker は `DATABASE_URL` / `SQS_QUEUE_URL` / `OPENSEARCH_URL` を環境変数で受けるため、環境変数の差し替えだけでサイト別に配置できる（SQS メッセージにテナント識別子は不要）

## 検討した選択肢

### A) 完全分離（現状の環境複製）

サイトごとに ADR-031 の環境を 1 つずつ作る。分離は最強だが、固定費（OpenSearch + Aurora 最小 ACU + NAT）がサイト数に線形で増え、コスト削減にならない。

### B) アプリ内マルチテナント

単一アプリに `site_id` を導入し全テーブル・全クエリ・検索インデックス・SQS メッセージでフィルタする。インフラは最小になるが、シングルサイト前提が全層（ブランド層のフォーク運用、`system_setting`、user テーブル、パイプライン）に浸透しているため事実上の再設計になる。アプリのバグが即サイト間の情報漏洩になる点も重い。

### C) インスタンス共用 + サイト単位の論理分離（採用）

時間課金される「箱」（Aurora クラスタ、OpenSearch ドメイン、VPC/NAT）だけを共用し、データと名前空間を持つ論理リソースはすべてサイト別にする。アプリコードの変更は index prefix の配線程度で済み、分離は資格情報レベル（DB ロール）で担保できる。

## 決定

**選択肢 C を採用する。CDK を SharedStack（共用の箱）と SiteStack × N（サイト別リソース）に分割し、ADR-031 の環境軸と直交する 2 軸構成（環境 × サイト）とする。**

### 共有 / サイト個別の整理

| 分類                        | リソース                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **共有（SharedStack）**     | VPC・サブネット・NAT・SG、Aurora クラスタ、OpenSearch ドメイン、ECS クラスタ、CDK Pipeline（1 本）、Worker イメージ（ブランド非依存・1 個）                                                                                                                            |
| **サイト個別（SiteStack）** | PostgreSQL データベース + 専用ロール・シークレット、OpenSearch インデックス（prefix）、S3 バケット、SQS キュー + DLQ、ECS サービス（web / worker タスク）、web イメージ（ADR-042）、CloudFront + ドメイン + ACM 証明書（+ WAF）、環境変数一式、CloudWatch ロググループ |
| **中間（段階的最適化）**    | ALB はまずサイト別、ホストベースルーティングによる共用は第二段階                                                                                                                                                                                                       |

原則: **時間課金される「箱」は共有、データと名前空間を持つ「論理リソース」はサイト別。**

### 構成

```
KukanPipeline（フォーク、1 本）
├─ Dev ステージ                    ← 環境軸は ADR-031 のまま
│   ├─ SharedStack (dev)           ← 小構成（OpenSearch なし + SEARCH_TYPE=postgres も可）
│   └─ SiteStack × n(dev)          ← サイト一覧は環境ごとに定義（dev は最小限でよい）
└─ Prd ステージ
    ├─ SharedStack (prd)
    └─ SiteStack × n(prd)          ← カナリア → 以降 1 サイトずつ直列（接続数バジェットの前提）
```

- 命名規約を `kukan-<env>-*`（ADR-031）から `kukan-<env>-<site>-*` に拡張する
- `environments.ts` の各環境が `sites: []` を持ち、サイトごとにブランド名（ADR-042）・ドメイン・証明書 ARN 等を宣言する
- SharedStack → SiteStack の参照は CloudFormation Export ではなく SSM パラメータ経由の疎結合とし、共用側の変更がサイト参照でロックされる事態を避ける

### サイト分離の実体

- **PostgreSQL**: 1 サイト = 1 データベース + 専用ロール。他サイト DB への CONNECT を持たない資格情報を Secrets Manager でサイト別に払い出す。サイト DB とロールの作成は Custom Resource（Lambda）が行う（CDK は素では DB 内オブジェクトを作れない）。マイグレーションは各サイトのタスクが起動時に自分の DB へ advisory lock 付きで実行する現行方式のまま
- **OpenSearch**: `OPENSEARCH_INDEX_PREFIX` 環境変数を新設し、`packages/api/src/adapters.ts` から `indexPrefix` に配線する（アプリ側の唯一の変更）。parent-child 統合インデックス（ADR-025）はサイトごとに 1 インデックスになる
- **Worker**: サイトごとにキュー + Worker サービスを維持する（環境変数の差し替えのみ、コード変更なし）。Worker 共有化（メッセージへのサイト識別子付与 + 接続の動的解決）はサイト数が増えてからの最適化とする

### デプロイの挙動

CDK のイメージアセットはコンテンツハッシュ管理のため、**変更のあったサイトだけが実際にデプロイされる**。

- 本体コードの変更 → 全サイトの web イメージが変わり、全サイトが順次ローリングデプロイ
- 特定ブランドのみの変更（ADR-042）→ 該当サイトのイメージだけ変わり、**他サイトは no-op**
- アセットは synth 時に一度だけビルドされ Dev / Prd 両ステージに同一イメージが配られるため、「dev で検証したイメージがそのまま prd に出る」プロモーションが仕組みで保証される

### 非 AWS 環境（Docker Compose / オンプレ・閉域）

同じ「箱共有・論理個別」モデルが成立する。エッジは Caddy 1 本のバーチャルホストで済むため、CloudFront × N が必要な AWS よりむしろ簡単。

```
共有 compose（1 回起動）: postgres / opensearch / minio / elasticmq / ollama / caddy
サイト compose × N     : web-<site> / worker-<site>（共有側の external network に join）
```

実装時の compose 側変更点:

- `container_name: kukan-*` の固定をやめる（複数プロジェクトで衝突するため）か `kukan-<site>-*` 化
- サイト DB 作成: `/docker-entrypoint-initdb.d` の init スクリプトまたは運用手順（AWS の Custom Resource に相当）
- ElasticMQ: `docker/elasticmq.conf` にサイトごとのキューを追記（静的定義のため）
- MinIO: `minio-init` をサイトごとのバケット作成に拡張
- OpenSearch ヒープ（`OPENSEARCH_JAVA_OPTS`）とホストメモリの容量計画がサイト数の実質上限を決める

アプリ層（index prefix、`POSTGRES_DB`、ブランドビルド）は AWS / 非 AWS で完全に共通で、環境差はインフラ定義（CDK / compose）に閉じる。

## トレードオフ

- **OpenSearch のサイト間分離は規約ベース**: ドメインのアクセス制御は VPC + SG（AWS）／認証なし（compose、security plugin 無効）であり、index prefix は命名規約にすぎない。サイトごとの IAM ロール + インデックスパターンで絞ったリソースポリシー（SigV4 署名の実装が必要）や FGAC 有効化という強化パスはあるが、初期は**同一運用主体のサイト群のみ共用する**というポリシーで割り切る
- **DB バックアップの粒度低下**: Aurora の PITR / スナップショットはクラスタ単位。「1 サイトだけ戻す」にはクラスタをクローンして該当 DB を pg_dump / restore する手順になり RTO が伸びる。サイト単位の論理バックアップ（pg_dump 定期実行）を補完する（ADR-037 の前提変更）
- **爆発半径の共有**: 共用 Aurora / OpenSearch の障害・メンテナンス・エンジンアップグレードは全サイトに同時波及する。SLA 要求が近いサイト同士だけを共用する同居ポリシーが必要。なお 1 サイト分のデータは DB・インデックス・バケット単位で閉じているため、後から特定サイトを別クラスタへ退避することは可能（同居は不可逆な決定ではない）
- **接続数の掛け算**: Web プール（`WEB_DB_POOL_MAX`）× タスク数 + Worker プールがサイト数分掛かる。Aurora Serverless v2 の max_connections は maxACU に連動するため、サイト数に応じた見直しが必要（将来的には RDS Proxy も選択肢）
- **共用ドメインのサイジング**: 1 サイトの再インデックス（bulk 投入）が全サイトの検索レイテンシに波及する。複数サイトを載せる共用 OpenSearch は medium（m6g.large.search）以上を推奨（強制はしない — 2 サイト以上を burstable インスタンスに載せると synth 時に警告を出す）
- **AI クォータの共有**: Bedrock の invoke クォータはアカウント共有。複数サイトの一括 embedding ジョブが同時に走るとスロットリングし得る（Ollama の場合は CPU 推論の競合として同様）
- **パイプライン所要時間**: 1 push あたり「dev のサイト数 + prd のサイト数」分のデプロイが直列で流れる。dev のサイト数の絞り込みで対処する（Wave 並列化は、接続数バジェットが複数サイトの同時更新分を計上するよう変更した場合のみの将来対応）

## 既存環境のマイグレーション

本 ADR は既存のシングルサイト環境に移行を強制しない。

- **既存環境は現行構成のまま（マルチサイトは opt-in）**: `environments.ts` に `sites` を持たない環境は、従来どおり全部入り `KukanStack` + `kukan-<env>-*` 命名で合成する。SharedStack / SiteStack 分割はマルチサイトを宣言した環境にのみ適用する。constructs（network / database / search 等）は両スタック形状で共用するため、二重実装にはならない
- **新規環境は最初から `sites` で始めることを推奨**: 後から `sites` を追加する in-place 移行は置換になるため、将来サイトを増やす可能性がある新規構築は `sites` 1 件（例: `sites: [{ name: 'main' }]`）のマルチサイト形状で開始する。証明書自動作成と AWS Backup 分割（2026-07-20 緩和）により、シングルサイト形状に対する機能差はない
- **既存環境を新構成へ移す場合はブルーグリーン**: スタック間のリソース移動と物理名変更（Aurora `clusterIdentifier`、OpenSearch `domainName` 等）は CloudFormation 上の置換となるため、in-place の載せ替え（`cdk refactor` / retain + `cdk import`）は行わない。新構成を並行構築し、pg_dump / restore + S3 sync + 再インデックスの後に DNS を切り替え、旧環境を破棄する。複雑さは運用手順に閉じ、切り戻しも可能
- **実装ガードレール（二形状のドリフト対策）**: 実ロジックは既存の constructs（network / database / search 等）に置いたまま、形状分岐はスタック合成の 1 点に封じ込める。シングルサイト形状は construct ツリーのパス（= 論理 ID）を現行から変えないことを必須条件とし、リファクタ前後の synth テンプレートのゴールデン diff と、CI の synth スナップショットテストで機械検証する（ラッパー construct を挟むとパスが変わり全リソース置換になるため不可。素の関数への切り出しはツリーに現れないため安全）。この制約下で両形状を単一の合成コードに統一することを実装目標とし、維持できない場合は薄い配線層を 2 つ持つ構成に後退して、両形状のスナップショットテストでドリフトを検出する

## 影響（実装時の変更点）

- `infra/`: SharedStack / SiteStack への分割、`environments.ts` への `sites` 追加、命名 `kukan-<env>-<site>-*`、サイト DB・ロール作成の Custom Resource、SSM 経由のスタック間参照
- `packages/shared/src/env.ts`: `OPENSEARCH_INDEX_PREFIX` の追加
- `packages/api/src/adapters.ts`: `indexPrefix` の配線
- `compose.yml` / `docker/`: 共有 / サイトの compose 分割テンプレート、`container_name` の整理、ElasticMQ conf・MinIO init の複数サイト対応
- `docs/specs/phase4-deploy.md`: マルチサイト構成手順の追記
- ブランドの複数化は ADR-042 で扱う

## 関連

- ADR-031（マルチ環境デプロイ設計）: 本 ADR は環境軸の内側にサイト軸を追加する拡張。置換ではない
- ADR-042（マルチブランドビルド）: サイトごとの web イメージを供給する
- ADR-025（OpenSearch parent-child 統合インデックス）: サイトごとに 1 インデックスとなる
- ADR-036（ランタイムシステム設定）: DB がサイト別のため自動的にサイト別になる
- ADR-037（バックアップ戦略）: DB バックアップ粒度の前提が変わる（本 ADR トレードオフ参照）
- ADR-038（初回ユーザーブートストラップ）: サイトごとに独立して機能する（DB 単位）
