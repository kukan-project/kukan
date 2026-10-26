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

## License / ライセンス

By contributing to KUKAN, you agree that your contributions will be
licensed under the [GNU Affero General Public License v3.0](LICENSE) and
that you grant the rights described in the [CLA](CLA.md).

KUKAN に貢献することにより、あなたの貢献が
[GNU Affero General Public License v3.0](LICENSE) の下でライセンスされること、
および [CLA](CLA.md) に記載された権利を付与することに同意したものとみなされます。
