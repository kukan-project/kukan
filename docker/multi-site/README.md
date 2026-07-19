# KUKAN マルチサイト Compose テンプレート(ADR-041)

1 台のホスト(またはオンプレ環境)で複数の KUKAN サイトを運用するための
opt-in テンプレート集。AWS 版(SharedStack / SiteStack)と同じ
「時間課金の箱は共有・データと名前空間はサイト別」モデルを Docker Compose で構成する。

通常のシングルサイト運用はリポジトリルートの `compose.yml` をそのまま使う。
本ディレクトリのファイルは**コピーして編集する前提のテンプレート**であり、
`compose.yml` とは独立している(サービス設定を変更する際は両方を見直すこと)。

## 構成

```
共有スタック(1 回起動): postgres / minio / elasticmq / opensearch / ollama / caddy
                          └ ネットワーク kukan-shared(attachable)
サイトスタック × N       : web-<site> / worker-<site>(kukan-shared に join)
```

- 分離の実体は AWS 版と同一: サイト別 DB + 専用ロール(`kukan_<site>`)、
  OpenSearch インデックス prefix(`kukan-<site>-search`)、S3 バケット、SQS キュー
- エッジは Caddy 1 本のバーチャルホスト(`Caddyfile`)

## セットアップ手順

### 1. 共有スタックの起動

```bash
# サイト一覧に合わせて事前に編集するもの:
#   - elasticmq.conf   … サイトごとのキュー定義(静的)
#   - Caddyfile        … サイトごとの vhost
#   - S3_BUCKETS       … サイトごとのバケット名(スペース区切り)
S3_BUCKETS="kukan-citya kukan-cityb" \
  docker compose -f docker/multi-site/compose.shared.yml up -d
```

### 2. サイト DB とロールの作成(サイトごとに 1 回)

```bash
sed -e 's/__SITE__/citya/g' -e 's/__PASSWORD__/<生成したパスワード>/g' \
  docker/multi-site/init-site-db.sql.example \
  | docker exec -i kukan-shared-postgres psql -U kukan -d postgres
```

### 3. サイトスタックの起動(サイトごと)

```bash
cp docker/multi-site/sites/citya.env.example docker/multi-site/sites/citya.env
# SITE / SITE_URL / SITE_DB_PASSWORD / SITE_AUTH_SECRET を編集

docker compose -f docker/multi-site/compose.site.yml \
  --env-file docker/multi-site/sites/citya.env -p kukan-citya up -d --build
```

初回起動時に各サイトの web/worker が自分の DB へマイグレーションを実行する
(advisory lock 付き、シングルサイトと同じ仕組み)。共有スタック側の起動が
完了していない間はヘルスチェック失敗で再起動を繰り返し、揃い次第安定する
(プロジェクトをまたぐ `depends_on` は使えないため)。

### 4. サイトの追加

1. `elasticmq.conf` にキュー 2 本(`kukan-<site>-pipeline` / `-dlq`)を追記 →
   `docker compose -f docker/multi-site/compose.shared.yml restart elasticmq`
2. `S3_BUCKETS` に追加して `minio-init` を再実行(`up -d` で再走する)
3. `Caddyfile` に vhost を追記 → `docker exec kukan-shared-caddy caddy reload -c /etc/caddy/Caddyfile`
4. 手順 2〜3 を新サイトで実行

## セキュリティ境界(重要)

この構成は**同一運用主体が全サイトを運用する前提**であり、サイト間の
ハードなマルチテナント境界ではない(ADR-041 のトレードオフに明記):

- **資格情報レベルで分離されるのは PostgreSQL のみ**(サイト別ロール +
  `REVOKE CONNECT`)。他サイトの DB には接続できない
- **MinIO / ElasticMQ / OpenSearch は共有資格情報・認証なし**で、バケット名・
  キュー名・インデックス prefix は命名規約にすぎない。サイトのコンテナが
  侵害された場合、他サイトのオブジェクト・キュー・インデックスへ到達できる
- 信頼できない相手にサイトを提供する用途には使わないこと。その要件が出た
  場合の強化パスは、MinIO のサイト別ユーザー + バケットポリシー
  (`mc admin user add` / `mc admin policy attach`)、OpenSearch security
  plugin の有効化、サイト別 ElasticMQ 等 — もしくは AWS 版(SG + IAM)や
  完全分離(ADR-041 選択肢 A)を検討する

## キャパシティ計画

- **OpenSearch ヒープ**(`OPENSEARCH_JAVA_OPTS`、既定 2g)が実質的なサイト数上限を
  決める。全サイトのインデックスが 1 JVM を共有するため、サイト追加に合わせて
  ヒープとホストメモリを増やす
- PostgreSQL の接続数はサイト数 ×(web/worker プール)で線形に増える
  (`WEB_DB_POOL_MAX` / `WORKER_DB_POOL_MAX` で調整)

## サイトの削除(パージ)

```bash
docker compose -p kukan-<site> down            # web/worker の停止・削除
docker exec -i kukan-shared-postgres psql -U kukan -d postgres \
  -c 'DROP DATABASE kukan_<site>' -c 'DROP ROLE kukan_<site>'
# MinIO バケット・OpenSearch インデックス(kukan-<site>-search)・
# elasticmq.conf / Caddyfile / S3_BUCKETS のエントリも忘れずに削除する
```
