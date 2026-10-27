# Contributing to KUKAN / KUKAN への貢献

Thank you for your interest in KUKAN!

KUKAN に関心をお寄せいただきありがとうございます。

## Current Status / 現在の状況

KUKAN is currently in active development and **we are not accepting
external contributions at this time**. This may change in the future as
the project matures.

KUKAN は現在開発中であり、**外部からのコントリビューションは受け付けて
いません**。プロジェクトの成熟に伴い、将来的に変更される可能性があります。

## Bug Reports and Feature Requests / バグ報告と機能要望

We welcome bug reports and feature requests via
[GitHub Issues](https://github.com/kukan-project/kukan/issues). When
filing an issue, please include:

バグ報告や機能要望は
[GitHub Issues](https://github.com/kukan-project/kukan/issues) で受け付けて
います。Issue を作成する際は、以下の情報を含めてください。

- A clear and descriptive title / 明確で分かりやすいタイトル
- Steps to reproduce the problem (for bugs) / 再現手順（バグの場合）
- Expected and actual behavior / 期待される動作と実際の動作
- Your environment (OS, Node.js version, browser) / 環境情報（OS、Node.js バージョン、ブラウザ）

## Future Contributions / 将来のコントリビューション

When we begin accepting contributions, all contributors will be required
to sign our [Individual Contributor License Agreement](CLA.md) before
any pull request can be merged. This ensures that the project can
continue to be offered under its dual-licensing model (AGPL-3.0 +
commercial).

コントリビューションの受け付けを開始する際には、プルリクエストのマージ前に
[Individual Contributor License Agreement (CLA)](CLA.md) への署名が必要と
なります。これはデュアルライセンスモデル（AGPL-3.0 + 商用）を維持するために
必要です。

## Requirements for Contributions / 貢献の要件

The project's own changes follow these rules today, and contributions
will follow the same when they are accepted:

- **Coding conventions**: naming, imports, error handling, database and
  test rules are in [AGENTS.md](AGENTS.md) (in Japanese), under
  「コーディング規約」. Design decisions are recorded as ADRs in
  [docs/adr/](docs/adr/).
- **Pull request titles** are in English and follow
  [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat`, `fix`, `docs`, `test`, ...); a check enforces it. A title
  becomes the commit message when the pull request is squash-merged.
- **Before committing**, `pnpm lint`, `pnpm typecheck` and `pnpm format`
  must pass.

プロジェクト自身の変更は今もこの規則に従っており、貢献を受け付けるときも
同じ規則に従っていただきます。

- **コーディング規約**: 命名・インポート・エラー処理・データベース・テストの
  規則は [AGENTS.md](AGENTS.md) の「コーディング規約」にあります。設計判断は
  ADR として [docs/adr/](docs/adr/) に記録しています。
- **プルリクエストのタイトル**は英語で、
  [Conventional Commits](https://www.conventionalcommits.org/ja/) に従います
  （`feat`・`fix`・`docs`・`test` など）。チェックで確かめます。squash マージの
  ときにタイトルがコミットメッセージになります。
- **コミットの前に** `pnpm lint`・`pnpm typecheck`・`pnpm format` が通ること。

## Tests / テスト

A pull request that adds or changes functionality adds or updates its
tests in the same pull request. CI runs every suite on every pull request
that changes code, and measures coverage on the development branch.

- Unit tests: Vitest (`*.test.ts`); integration tests against a real
  PostgreSQL: Vitest (`*.integration.test.ts`); end-to-end tests:
  Playwright (`*.e2e.ts`). Tests go in a `__tests__/` directory next to
  the code.
- Tests are type-checked like the code they test.
- `pnpm test` runs the unit and integration suites (integration needs the
  Docker Compose services); `pnpm test:coverage` adds coverage.

機能を足したり変えたりするプルリクエストは、同じプルリクエストでテストを
足すか直します。CI はコードを変えるすべてのプルリクエストで全テストを走らせ、
開発ブランチではカバレッジも取ります。

- ユニットテストは Vitest（`*.test.ts`）、実際の PostgreSQL に対する統合テストは
  Vitest（`*.integration.test.ts`）、E2E テストは Playwright（`*.e2e.ts`）。
  テストはコードの隣の `__tests__/` ディレクトリに置きます。
- テストも、テストするコードと同じく型検査します。
- `pnpm test` でユニットテストと統合テストを走らせます（統合テストには
  Docker Compose のサービスが要ります）。`pnpm test:coverage` でカバレッジも
  取ります。

## Database Migrations / データベースのマイグレーション

The schema is defined in `packages/db/src/schema/`, and migrations are
generated from it with Drizzle Kit into `packages/db/drizzle/`. The Worker
applies pending migrations when it starts, all in one transaction.

- **Generating**: edit the schema, run
  `pnpm --filter @kukan/db db:generate`, then `pnpm format`. Commit the
  three generated files together: the `.sql`, its `meta/NNNN_snapshot.json`
  and `meta/_journal.json`. If another pull request took the same number,
  merge the development branch and generate again; do not renumber by hand.
- **Hand-written SQL**: you may add SQL to a generated migration when
  existing rows need it in the same step — a backfill, or moving data
  before a column goes. Put it where it must run: SQL that reads a column
  or table the migration drops goes before that `DROP`, not at the end.
  Keep comments in the SQL to one line and explain in the pull request.
- **Old code runs against the new schema.** During a deployment the
  previous release's processes keep running after the migration is
  applied. A migration must leave that code working:
  - add a column as nullable, or with a default — never `NOT NULL` without
    one;
  - to drop or rename a column, first release code that no longer uses it,
    and drop it in a later release;
  - to change what a value means, add a new column and move to it.
- **No down migrations.** To undo a change, write a new migration forward.
- **Do not break the previous release.** Split a change into expand and
  contract releases as above, so that no migration stops the previous
  images from running. If that cannot be avoided, the migration is a
  breaking change: mark the pull request title with `!`, and give the
  deployment procedure in the release notes — stop the old processes before
  the new Worker migrates (on Docker Compose, `down` before `up`), and say
  that rolling the images back will not restore them.
- **Locks**: DDL waits at most 5 seconds for a table lock and is retried,
  but every query on that table queues behind it while it waits. Avoid
  statements that rewrite a large table. `CREATE INDEX CONCURRENTLY` cannot
  run inside the migration transaction.
- **Tests**: add a new table to `cleanDatabase()` in the API and Worker
  test helpers. If a change alters the SQL that a query emits, update the
  snapshots in `packages/api/src/__tests__/services/sql-shape.integration.test.ts`
  in the same pull request so the difference can be reviewed.
- **Documents**: a new table, or a change to a table's role or its `state`
  values, updates [docs/design-v4.md](docs/design-v4.md) §6.

スキーマは `packages/db/src/schema/` に定義し、マイグレーションはそこから
Drizzle Kit で `packages/db/drizzle/` に生成します。Worker が起動時に、
未適用のマイグレーションを 1 つのトランザクションで適用します。

- **生成**: スキーマを編集し、`pnpm --filter @kukan/db db:generate`、続けて
  `pnpm format` を実行します。生成される 3 つのファイル（`.sql`、
  `meta/NNNN_snapshot.json`、`meta/_journal.json`）は一緒にコミットします。
  他のプルリクエストと番号が重なったら、開発ブランチを取り込んで生成し直します。
  番号を手で付け替えないでください。
- **手で書く SQL**: 既存の行に同じ段階で手当てが要るとき（バックフィル、列を
  消す前のデータの移し替え）は、生成されたマイグレーションに SQL を足して
  かまいません。走るべき位置に置きます。同じマイグレーションが消す列や表を
  読む SQL は、末尾ではなくその `DROP` より前に置きます。SQL 内のコメントは
  1 行にとどめ、説明はプルリクエストに書きます。
- **古いコードが新しいスキーマで動きます。** デプロイ中は、マイグレーションの
  適用後も前のリリースのプロセスが動き続けます。マイグレーションはそのコードを
  壊してはいけません。
  - 列は null を許すか、既定値付きで足します。既定値の無い `NOT NULL` にしません
  - 列を消す・名前を変えるときは、先にその列を使わないコードをリリースし、
    消すのは後のリリースにします
  - 値の意味を変えるときは、新しい列を足してそちらへ移します
- **down マイグレーションは書きません。** 変更を取り消すときは、前に進む新しい
  マイグレーションを書きます。
- **前のリリースを壊しません。** 上のとおり拡張と縮小のリリースに分け、どの
  マイグレーションも前のイメージを動かなくしないようにします。避けられない
  ときは破壊的変更です。プルリクエストのタイトルに `!` を付け、リリースノートに
  デプロイの手順を書きます。新しい Worker がマイグレーションを適用する前に古い
  プロセスを止めること（Docker Compose では `up` の前に `down`）、イメージを
  戻しても元には戻らないことです。
- **ロック**: DDL は表のロックを最大 5 秒待って再試行しますが、待っている間は
  その表への問い合わせがすべて後ろに並びます。大きな表を書き換える文は避けます。
  `CREATE INDEX CONCURRENTLY` はマイグレーションのトランザクションの中では
  使えません。
- **テスト**: 新しい表は API と Worker のテストヘルパーの `cleanDatabase()` に
  足します。クエリが発行する SQL が変わるときは、同じプルリクエストで
  `packages/api/src/__tests__/services/sql-shape.integration.test.ts` の
  スナップショットを更新し、差分をレビューできるようにします。
- **文書**: 表を足した、または表の役割や `state` の値を変えたときは、
  [docs/design-v4.md](docs/design-v4.md) §6 を直します。

## License / ライセンス

By contributing to KUKAN, you agree that your contributions will be
licensed under the [GNU Affero General Public License v3.0](LICENSE) and
that you grant the rights described in the [CLA](CLA.md).

KUKAN に貢献することにより、あなたの貢献が
[GNU Affero General Public License v3.0](LICENSE) の下でライセンスされること、
および [CLA](CLA.md) に記載された権利を付与することに同意したものとみなされます。
