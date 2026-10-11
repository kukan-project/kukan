# Node.js の版を変えるとき

Node.js の版はリポジトリのあちこちに書かれている。上げるときはこの一覧を上から順に直し、
同じ 1 つの PR にまとめる。一部だけ上げると、手元・CI・本番で別の版が動く。

方針: 偶数の版だけを使い、LTS に入ってから上げる（毎年 10 月）。マイナー・パッチは
Docker イメージに合わせて手で上げる（Dependabot はこのレジストリのダイジェストを上げない）。

## 一覧

| 場所                                                              | 書き方                            | 上げるとき                      |
| ----------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| `Dockerfile` の `FROM`                                            | タグ + ダイジェスト、コメントに版 | 毎回                            |
| `.node-version`                                                   | 完全な版（Dockerfile と同じ）     | 毎回                            |
| `.github/workflows/ci.yml`、`deploy-site.yml` の `setup-node`     | メジャー                          | メジャー                        |
| `infra/lib/pipeline-stack.ts` の `NODE_MAJOR`                     | メジャー（CodeBuild の runtime）  | メジャー                        |
| `infra/lib/constructs/site-database.ts`、`deploy-notification.ts` | `lambda.Runtime.NODEJS_XX_X`      | メジャー（Lambda の対応を待つ） |
| 全 `package.json` の `@types/node`                                | `^XX.y.z`（lock は 1 つの版）     | メジャー                        |
| `.github/dependabot.yml` の `@types/node` のメジャー除外          | —                                 | メジャー（除外はそのまま残す）  |
| `apps/worker/tsup.config.ts` の `target`                          | `nodeXX`                          | メジャー                        |
| `packages/api/package.json` の `build`（esbuild の `--target`）   | `nodeXX`                          | メジャー                        |
| ルート `package.json` の `engines.node`                           | `>=XX.0.0`                        | メジャー                        |
| `CLAUDE.md`、`README.md`、`site/` の getting-started（日英）      | 文中の版                          | メジャー                        |

Lambda の版を上げると `infra/lib/__tests__/__snapshots__/` のスナップショットが変わる
（`pnpm vitest run --project infra -u`）。

`@types/node` はルートの `pnpm.overrides` が全パッケージをルートの宣言にそろえる
（`"$@types/node"`）。間接依存（`@types/pg` など）も同じ版に解決される。2 つのメジャーが
lock に混ざると、vitest が両方を読み込んで壊れたことがある。

## pnpm

pnpm の版はルート `package.json` の `packageManager`（版と sha512）だけが持つ。Dockerfile と
CDK Pipelines の synth は `scripts/install-pnpm.sh` でその版を取得し、ハッシュを照合して入れる。
Node 25 から corepack が同梱されなくなったので、corepack には頼らない。手元で新しい Node を
入れたときも同じスクリプトで入る（nodenv なら `sh scripts/install-pnpm.sh "$(nodenv prefix)"`）。

CI は `pnpm/action-setup` が `packageManager` を読む。

## メジャーを上げるときに測り直すもの

- 子プロセスのメモリ予算（`QUERY_PROCESS_BASE_MB`、`HEAVY_PARENT_RESERVE_MB`）を small 構成で
- 組み込みの `fetch` は Node に同梱の undici の版で動く（worker の外部取得は npm の undici で、
  Node の版には左右されない）
- `Dockerfile` のランタイムのステージは npm・corepack・yarn を消している。Node 26 のイメージには
  corepack と yarn がもう入っていない（npm は残る）。`rm -rf` は無いパスでも失敗しないので、
  消す一覧は残しておいてよい
