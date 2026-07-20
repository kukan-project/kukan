# ADR-042: マルチブランドビルド（`KUKAN_BRAND` によるブランド選択）

## ステータス

**承認済み（Accepted）** — 実装済み。ADR-023（ブランドオーバーライドレイヤー）を置換せず**拡張**する。フォーク運用を前提としたブランドレイヤーはそのまま、フォーク内に複数ブランドを持てる選択機構を追加する。

実装時の確定事項（提案本文からの差分）:

- デフォルトブランドを `src/brand/` から **`brands/default/`** へ移設し、全ブランドを `brands/` 配下に一元化した（対称化）。デフォルトも含め `@/brand` の解決先は常に `brands/<brand>`（未指定時 `default`）
- デフォルトは **tsconfig の paths**（`@/brand` → `brands/default`）で静的解決するため、素の OSS ビルド／型検査／テストは alias 機構に依存しない。`KUKAN_BRAND` 指定時のみ `next.config.ts` が解決先を上書きする
- スキャフォールド用の `brands/example/` は置かない。**新ブランドは `brands/default/` をコピー**して作る（default が実体かつ参照テンプレート）
- 静的アセットは常にアクティブブランドの `public/` から `public/brand/`（生成物・gitignore）へコピーする（デフォルトは `brands/default/public/`）
- 既存フォークの移行が必要（後述）

## コンテキスト

ADR-023 のブランドレイヤーは「1 フォーク = 1 ブランド」を前提とし、フォークがブランドディレクトリ（当時 `apps/web/src/brand/`）を直接編集する。1 つのフォークが複数サイト（ADR-041）を運用する場合、ブランドを複数持つ必要があるが、現行構造ではサイトごとにフォークを増やすしかなく、upstream 追従コストがサイト数に比例してしまう。

本体（OSS）側に必要なのは**複数ブランドを選択できる機構**だけであり、ブランドの実体はフォーク側が持つ。この役割分担なら公開リポジトリに導入組織固有の情報（ロゴ・組織名・独自ページ）が載ることはない。

## 検討した選択肢

### A) ビルド時選択 — ブランドカタログ（採用）

フォークが `apps/web/brands/<name>/` を複数持ち、ビルド引数 `KUKAN_BRAND` で `@/brand` の解決先を切り替える。サイトごとに web イメージを作る。

- ADR-023 の資産（型定義、スロット機構、テスト戦略、静的ページの TSX）を一切変えずに成立する
- ビルドに含まれるのは選択された 1 ブランドのみで、ブランド間でバンドルが混ざらない
- サイトごとに ECS サービスが分かれる ADR-041 の構成では「1 プロセス = 1 ブランド」で十分であり、リクエスト単位のブランド解決は不要

### B) 起動時選択 — 全ブランド同梱

全ブランドを 1 イメージに同梱し、環境変数で起動時に選択する。イメージは 1 個で済むが、`import '@/brand/theme.css'` の静的インポート、`layout.tsx` の静的 `metadata`、クライアントコンポーネントへの config 伝播をすべてランタイム解決に書き換える必要があり、全ブランドがクライアントバンドルに同梱される。ADR-041 では「1 イメージ」の利点が薄く、割に合わない。

### C) ランタイムデータ駆動

設定・テーマ・文言を DB / S3 に置き管理画面で編集する。再ビルド不要になるが、Tier 2（コンポーネント差し替え）が失われ、静的ページも TSX で書けなくなる。将来、`brandConfig` のデータ的な項目（siteName、フッターリンク等）だけを ADR-036 のランタイム設定へ段階移行する道は残す。

## 決定

**選択肢 A を採用する。本体は `KUKAN_BRAND` によるブランド選択機構のみを提供し、ブランドの実体はフォークが `apps/web/brands/` に追加する。**

### ディレクトリ構造

```
apps/web/
└── brands/
    ├── default/        ← デフォルトブランド（本体が持つ実体・参照テンプレート）
    │   └── brand-config.ts / theme.css / messages/ / overrides/ / pages/ / public/
    ├── _shared/        ← フォーク運用者の共通部品（任意・フォークが追加）
    └── <name>/         ← フォークが追加するブランド（default をコピーして作る）
```

- `KUKAN_BRAND` 未指定 → **`brands/default/`** を使用（tsconfig の paths `@/brand` → `brands/default` で静的解決）。素の OSS ビルド・型検査・テストは alias 機構に依存しない
- `KUKAN_BRAND=<name>` → `next.config.ts` が `@/brand`（と各サブパス）の解決先を `apps/web/brands/<name>/` に上書き
- 置き場所をリポジトリルートではなく `apps/web/brands/` とするのは、Next.js のコンパイル対象・tsconfig の include・`@/components/*` 等のエイリアス解決をアプリ内で完結させるため

### 機構（本体側の実装）

1. **既定の解決**: `apps/web/tsconfig.json` の paths で `@/brand` → `brands/default`、`@/brand/*` → `brands/default/*`。vitest（ルート `vitest.config.ts` の web プロジェクトと `apps/web/vitest.config.ts` の両方）の alias も同じく `brands/default` を指す
2. **ブランド指定時の上書き**: `next.config.ts` が `KUKAN_BRAND`（`default` 以外）のとき `@/brand` / `@/brand/theme.css` / `@/brand/pages` / `@/brand/brand-config` / `@/brand/messages` を `brands/<name>/` へ上書き。Turbopack の `resolveAlias` は完全一致のため各サブパスを列挙する（値はプロジェクト相対）。webpack にも同じ対応（値は絶対パス）
3. **静的アセット**: `scripts/copy-brand-assets.mjs` が dev/build 前にアクティブブランドの `public/` を `public/brand/`（生成物・gitignore）へコピー。宛先は全ブランド共通、未指定時は `brands/default/public/`。実行時は `/brand/...` で配信
4. **Dockerfile**: web ビルドステージに `ARG KUKAN_BRAND` + `ENV`。`turbo.json` の build タスク `env` に `KUKAN_BRAND` を含めキャッシュキーに反映
5. **型チェック**: `brands/` は `apps/web` の tsconfig include（`**/*.ts`）に含まれ、`pnpm typecheck` が**全ブランドを一括検査**する。`BrandConfig` / `BrandOverrides` の破壊的変更は、ブランドを持つフォークの CI で全ブランド分まとめて検出される
6. **lint / テスト**: lint 対象を `src brands` に拡張（default の lint 回帰防止）。本体テストは `brand-defaults.ts` モックでブランド非依存のまま（ADR-023 のテスト戦略は無変更で有効）

### フォーク運用ルールの拡張

ADR-023 の「フォーク側の変更はブランドディレクトリに限定する」はそのままに、対象を **`brands/` 配下**とする。フォークがカスタマイズするのは `brands/default/`（デフォルトの見た目を変える場合）、追加するのは `brands/<name>/`（本体に存在しないファイルのみで構成されるため upstream とのマージ衝突がない）。

- ブランド間の共通部品は `brands/_shared/` に置き、各ブランドの `overrides/` から import する（ADR-023 の「本体コンポーネント再利用」パターンの水平版）
- ブランド固有の npm 依存はフォークの `apps/web/package.json` に追加する。ビルドに入るのは使用ブランドの分だけなので、他ブランドのバンドルは太らない
- ブランド固有テストは `brands/<name>/__tests__/` に置く

### デプロイとの関係（ADR-041）

- サイト定義（`environments.ts` の `sites`）がブランド名を持ち、パイプラインがサイトごとに `KUKAN_BRAND` を変えて web イメージをビルドする（タグ例: `web-<site>-<version>`）
- Worker はブランドを含まないため、イメージは全サイト共通の 1 個
- CDK のイメージアセットはコンテンツハッシュ管理のため、**特定ブランドだけの変更は該当サイトだけのローリングデプロイになり、他サイトは no-op**
- 非 AWS 環境ではサイト compose の `build.args` に `KUKAN_BRAND` を書く。ブランド機構に AWS / 非 AWS の差分はない

### `name` と `brand` を分ける（流用しない）理由

サイトの `name`（ADR-041）と `brand` は別軸として保ち、`brand` に `name` を流用しない:

- **1 ブランドを複数サイトで共有できる**: 県ブランドを市サイト群で使う等、`{ name: 'citya', brand: 'gov' }` / `{ name: 'cityb', brand: 'gov' }` と書ける。`name` を流用すると同一内容の `brands/<name>/` をサイト数分複製する羽目になり、`brands/_shared/` の意義も薄れる
- **既定ブランドで素直に動く（opt-in）**: `brand` 未指定 → `KUKAN_BRAND` を渡さない → `src/brand/`（既定ブランド）を使用。`name` を流用すると未カスタマイズのマルチサイト環境でも `KUKAN_BRAND=<name>` が渡り、`brands/<name>/` が無いとイメージビルドが失敗する（未知の build arg 扱い）。ADR-041 の「マルチサイトを標準形状にし、素の構成でそのまま動かす」方針と衝突する
- **制約とレイヤーが違う**: `name` は PostgreSQL 識別子ゆえ 16 文字・ハイフン不可の枷を持ち、インフラ側の同一性（`environments.ts`）に属する。`brand` はフォーク所有のコンテンツ選択（`apps/web/brands/`）で命名の枷もない

### CSS 変数のルールは全ブランド共通

テーマトークンの契約——`globals.css` の `--color-*` マッピングと `@theme inline`、および各ブランドの `theme.css` が守るルール（素の HSL 三つ組・対になるトークンの同時更新・コントラスト 4.5:1・ライトテーマのみ・`--color-*` は触らない）——は**アプリ層の契約**であり、ブランド層の外にある。各ブランドの `theme.css` は raw トークンの**値のみ**を同じルールに従って差し替える。ビルド時にどのブランドを選んでも共有コンポーネントは同じトークン名を参照するため、ルールをブランドごとに変える理由はなく、変えると ADR-023 とブランドトークン方針が担保する破綻回避（shadcn/ui 内部を壊さない）が崩れる。

## トレードオフ

- **ビルド時間がブランド数に線形**: web の Next.js ビルドがサイト数分走る。pnpm install までの Docker レイヤーは全ブランド共通のため、差分は実質 Next.js ビルド 1 段。アセットの並列ビルドと ECR レイヤーキャッシュ（`cacheFrom`）で緩和する
- **ブランド変更にも再ビルドが必要**: ロゴ 1 つの差し替えでもイメージビルドが走る。「再ビルドなしで変えたい」要求が強くなったら、データ的な項目のみ選択肢 C（ADR-036 ランタイム設定）へ段階移行する
- **解決経路が二本**: 既定は tsconfig paths、ブランド指定時は next.config の alias、と経路が分かれる（vitest も alias を別途持つ）。ブランドごとの厳密な型チェック（`@/brand` 解決込み）が必要になれば paths を差し替える `typecheck:brand` スクリプトを別途用意する

## 既存フォークの移行

デフォルトブランドの置き場所が `src/brand/` から `brands/default/` へ移る一度きりの破壊的変更がある（ADR-023 の「既存フォークは無変更」は本 ADR で更新される）。

- **`src/brand/` を編集していたフォーク**: 中身を `apps/web/brands/default/` へ移す（`git mv apps/web/src/brand apps/web/brands/default`）。`@/brand` のインポートは不変なのでアプリ側コードの変更は不要
- **`public/brand/` にアセットを置いていたフォーク**: `apps/web/brands/default/public/` へ移す（`public/brand/` は生成物になり gitignore される）。実行時の参照 URL `/brand/...` は不変
- 追加ブランドは `brands/default/` をコピーして `brands/<name>/` を作る

## 影響（実装時の変更点）

- `apps/web/brands/default/`: デフォルトブランド（`src/brand/` から移設）
- `apps/web/tsconfig.json`: paths に `@/brand` → `brands/default` を追加
- `apps/web/next.config.ts`: `KUKAN_BRAND` によるエイリアス上書き（Turbopack / webpack）
- `vitest.config.ts`（ルート）/ `apps/web/vitest.config.ts`: web の `@/brand` alias
- `apps/web/scripts/copy-brand-assets.mjs` + `package.json`: 静的アセットコピー、`public/brand/` の gitignore
- `apps/web/package.json`: lint 対象を `src brands` に拡張
- `Dockerfile` / `turbo.json`: web ビルドの `ARG KUKAN_BRAND` とキャッシュキー
- ドキュメント: フォーク向けカスタマイズガイドに複数ブランド手順を追記

## 関連

- ADR-023（ブランドオーバーライドレイヤー）: 本 ADR はその拡張。スロット機構・型変更ポリシー・テスト戦略はそのまま適用される
- ADR-041（マルチサイトデプロイ）: サイトごとの `KUKAN_BRAND` 指定でイメージを供給する
- ADR-036（ランタイムシステム設定）: 将来のデータ駆動化（選択肢 C）の受け皿
