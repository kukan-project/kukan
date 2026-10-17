# ADR-068 spike：Lambda Web Functions で web を動かせるか

ADR-068 の判断に使った検証用のコード。結果の数値と判定の正本は ADR-068 にあり、ここには
置かない（`results/` は生データなのでコミットしない）。

| 段階 | 置き場所   | 確かめること                                                                                           |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------ |
| 1    | `probe/`   | DuckDB なしで、web のクエリ経路が前提にしていること（`fork`、cgroup、OOM）                             |
| 2a   | `stage2a/` | KUKAN のクエリの子プロセスと、プロセス内の DuckDB（VPC なし）                                          |
| 2b   | `stage2b/` | DualStack の connector 経由で、DB・Secrets Manager・IPv6・Bedrock に届くか                             |
| 2c   | `stage2c/` | web 全体（Next.js の standalone）を同じ connector で置き、SSR・API・アップロード・ダウンロードが動くか |

どの段階も、エンドポイントは `ApplicationManaged`（公開）で作られる。全ルートが
`token.txt` のトークンを要求する（`token.txt` はコミットしない）。

## 準備

```bash
aws update                 # 2.18.16 には lambda-web が無い
export AWS_PROFILE=...     # 検証に使うアカウント
```

スクリプトの関数名の変数に `NAME` は使わない（VS Code の端末が `NAME=Code` を設定している）。
関数名を変えるときは `PROBE_NAME` を使う。

## 段階 1（`probe/`）

```bash
./deploy.sh                          # 東京に kukan-probe を作る
ENDPOINT=https://<domain> ./run.sh
./cleanup.sh                         # 関数・ロール・ログ群・パッケージを消す
```

| #   | 問い                                   | 見るところ                                                                   |
| --- | -------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `fork` できるか                        | `fork.json` の `reply` が返り `exit.code: 0`                                 |
| 2   | 子が OOM スコアを上げられるか          | `fork.json` の `reply.oomScoreAdj` が `"1000"`                               |
| 3   | cgroup のメモリ上限が読めるか          | `probe.json` の `cgroup.v2.memoryMax`（または v1）                           |
| 4   | 子のメモリが親の cgroup に計上されるか | `alloc-*.json` の `steps[].cgroupAnonMb`                                     |
| 5   | 2 GB を超えたとき誰が落ちるか          | `alloc-2300.json` と、`probe-after.json` の `pid` / `uptimeS` が続いているか |
| 6   | `/tmp` の実容量                        | `probe.json` の `fs.tmp`、`tmp-600.json` の `error`                          |
| 7   | arch / libc                            | `probe.json` の `arch`、`glibcRuntime`、`osRelease`                          |
| 8   | 起動時間                               | `probe.json` の `startupMs`                                                  |

3〜5 は ✕ だった（cgroup が無く、2 GB を超えると環境ごと止まる）。それでも段階 2 に進んだ。
環境は約 0.2 秒で自動的に作り直され、親による予算の監視が先に効けば起きないため（ADR-068
§コンテキスト 4・5）。

段階 1 のプローブは、環境が同時に受ける本数の測定にも使う（ADR-068 §決定 8）。

```bash
MAX_ENVS=2 ./concurrency.sh    # /sleep で各リクエストを 2 秒保ち、並行数を上げて 429 を数える
```

## 段階 2a（`stage2a/`）

```bash
stage2a/build.sh     # dist/ を作る。DuckDB は arm64 の Amazon Linux 2023 のコンテナで入れる（docker と QEMU）
stage2a/deploy.sh    # kukan-probe-duckdb を作る
# テストの Parquet を s3://<deploy が作るバケット>/spike-data/{small,large}.parquet に置く
aws iam put-role-policy --role-name awscli-lambdaweb-kukan-probe-duckdb --policy-name read-spike-data \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::<bucket>/spike-data/*"}]}'
ENDPOINT=https://<domain> stage2a/run.sh
```

- `server.ts` は KUKAN の `runQueryInProcess`（子プロセス、RSS の予算、サンドボックス）と
  `@kukan/lake` の `openDuckdb` を束ねる。`build.sh` は `packages/{api,lake,shared}/dist` を
  作り直さない（`pnpm dev` が使っているため）。古ければ手でビルドする。
- 署名付き URL は関数自身のロールで作る（web がタスクのロールで作るのと同じ）。手元の
  認証情報で署名した URL は、送り元の IP などの条件で拒否されることがある。
- `/diag` は httpfs が読めないときの切り分け用（HTTP クライアントの実装、HTTP のログ）。

## 段階 2b（`stage2b/`）

```bash
aws cloudformation deploy --region ap-northeast-1 --stack-name kukan-probe-vpc \
  --template-file stage2b/network.yaml --capabilities CAPABILITY_IAM --tags project=kukan-probe
stage2b/attach.sh    # DB の設定付きでデプロイし、connector を付けた revision を作る
# /secret /db /egress /bedrock を叩く（トークン付き）
stage2b/cleanup.sh   # kukan-probe-duckdb と spike-data/、続けて kukan-probe-vpc を消す
```

`network.yaml` は ADR-068 §決定 2 のネットワークを、専用の VPC に作る（デュアルスタックの
VPC、IPv6 で出る public サブネット、isolated の PostgreSQL、S3 のゲートウェイエンドポイント、
1 AZ の Bedrock Runtime のインターフェースエンドポイント、DualStack の connector）。
NAT とパブリック IPv4 アドレスは使わない。スタックごと消せる。

`/migrate` は段階 2c のために KUKAN のマイグレーションを当てる（DB は手元から届かず、
マイグレーションを当てる worker も置かないため）。

## 段階 2c（`stage2c/`）

```bash
# web をビルドする worktree。glibc の arm64 のバイナリも入れる（pnpm dev の .next を避けるため別に作る）
git worktree add --detach ../kukan-web-arm64 HEAD && cd ../kukan-web-arm64
printf '\nsupportedArchitectures:\n  os: [linux]\n  libc: [glibc]\n  cpu: [x64, arm64]\n' >> pnpm-workspace.yaml
pnpm install --frozen-lockfile && pnpm turbo run build --filter=@kukan/web...
cd - && WEB_WORKTREE=../kukan-web-arm64 stage2c/build.sh   # dist/ と web.zip
stage2c/deploy.sh    # 2 回走らせる（2 回目で BETTER_AUTH_URL がエンドポイントを指す）
stage2c/call.sh /api/health          # IamAuth なので SigV4 で署名して呼ぶ
```

- エンドポイントは `IamAuth`。空の KUKAN は最初に登録した人が sysadmin になる（ADR-038）ので、
  公開しない。`call.sh` は `@smithy/signature-v4` で署名する（curl 7.81 の SigV4 では 403）。
  `COOKIE` を渡せばセッション付きで呼べる。
- zip は自分で作る（`zip -y` で pnpm のシンボリックリンクを保つ）。
- DB のパスワードは環境変数で渡している（ADR-068 §決定 5 は起動時に Secrets Manager から取る形）。
- 片付けは `aws lambda-web delete-web-function --function-name kukan-probe-web`、ロール
  `kukan-probe-web`、`lambda-web/kukan-probe-web/` のパッケージ、ログ群 2 つ、そして
  `stage2b/cleanup.sh`（データ用のバケットを空にしてからスタックを消す）。
