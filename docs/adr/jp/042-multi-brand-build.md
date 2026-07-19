# ADR-042: マルチブランドビルド（`KUKAN_BRAND` によるブランド選択）

## ステータス

**提案（Proposed）** — ADR-023（ブランドオーバーライドレイヤー）を置換せず**拡張**する。フォーク運用を前提としたブランドレイヤーはそのまま、フォーク内に複数ブランドを持てる選択機構を追加する。

## コンテキスト

ADR-023 のブランドレイヤーは「1 フォーク = 1 ブランド」を前提とし、フォークが `apps/web/src/brand/` を直接編集する。1 つのフォークが複数サイト（ADR-041）を運用する場合、ブランドを複数持つ必要があるが、現行構造ではサイトごとにフォークを増やすしかなく、upstream 追従コストがサイト数に比例してしまう。

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
├── src/brand/          ← デフォルトブランド（現状のまま・無変更）
└── brands/             ← 本体では example のみ。フォークがブランドを追加する
    ├── example/        ← スキャフォールド用サンプル（src/brand のコピー相当）
    ├── _shared/        ← フォーク運用者の共通部品（任意）
    └── <name>/         ← brand-config.ts / theme.css / messages/ / overrides/ / pages/ / public/
```

- `KUKAN_BRAND` 未指定 → 従来どおり `src/brand/` を使用。**既存のシングルブランドフォークは何も変わらない**（完全後方互換、opt-in）
- `KUKAN_BRAND=<name>` → `@/brand` の解決先を `apps/web/brands/<name>/` に切替
- 置き場所をリポジトリルートではなく `apps/web/brands/` とするのは、Next.js のコンパイル対象・tsconfig の include・`@/components/*` 等のエイリアス解決をアプリ内で完結させるため

### 機構（本体側の実装）

1. **エイリアス切替**: `next.config.ts` で `KUKAN_BRAND` に応じて `@/brand` の解決先を変更（webpack / Turbopack `resolveAlias` 両対応）。vitest の alias も同様
2. **静的アセット**: prebuild スクリプトで `brands/<name>/public/` → `public/brand/` にコピー（未指定時はコピーなし）
3. **Dockerfile**: web ターゲットに `ARG KUKAN_BRAND` を追加
4. **型チェック**: `brands/` を `apps/web` の tsconfig include に含める。どのブランドをビルドするかに関係なく `pnpm typecheck` が**全ブランドを一括検査**するため、`BrandConfig` / `BrandOverrides` の破壊的変更は upstream 取り込み時の CI で全ブランド分まとめて検出される
5. **テスト発見**: vitest の include に `brands/**/__tests__/**` を追加。本体テストは `brand-defaults.ts` モックでブランド非依存のまま（ADR-023 のテスト戦略は無変更で有効）

### フォーク運用ルールの拡張

ADR-023 の「フォーク側の変更は `src/brand/` に限定する」を「**`src/brand/` または `brands/` に限定する**」に拡張する。フォークが追加する `brands/<name>/` は本体に存在しないファイルのみで構成されるため、upstream とのマージで衝突する余地がない（`src/brand/` より衝突耐性が高い）。

- ブランド間の共通部品は `brands/_shared/` に置き、各ブランドの `overrides/` から import する（ADR-023 の「本体コンポーネント再利用」パターンの水平版）
- ブランド固有の npm 依存はフォークの `apps/web/package.json` に追加する。ビルドに入るのは使用ブランドの分だけなので、他ブランドのバンドルは太らない
- ブランド固有テストは `brands/<name>/__tests__/` に置く

### デプロイとの関係（ADR-041）

- サイト定義（`environments.ts` の `sites`）がブランド名を持ち、パイプラインがサイトごとに `KUKAN_BRAND` を変えて web イメージをビルドする（タグ例: `web-<site>-<version>`）
- Worker はブランドを含まないため、イメージは全サイト共通の 1 個
- CDK のイメージアセットはコンテンツハッシュ管理のため、**特定ブランドだけの変更は該当サイトだけのローリングデプロイになり、他サイトは no-op**
- 非 AWS 環境ではサイト compose の `build.args` に `KUKAN_BRAND` を書く。ブランド機構に AWS / 非 AWS の差分はない

## トレードオフ

- **ビルド時間がブランド数に線形**: web の Next.js ビルドがサイト数分走る。pnpm install までの Docker レイヤーは全ブランド共通のため、差分は実質 Next.js ビルド 1 段。アセットの並列ビルドと ECR レイヤーキャッシュ（`cacheFrom`）で緩和する
- **ブランド変更にも再ビルドが必要**: ロゴ 1 つの差し替えでもイメージビルドが走る。「再ビルドなしで変えたい」要求が強くなったら、データ的な項目のみ選択肢 C（ADR-036 ランタイム設定）へ段階移行する
- **tsconfig の二重管理**: ビルド対象の切替は resolve alias、型チェックは include で全ブランド、と経路が分かれる。ブランドごとの厳密な型チェック（`@/brand` 解決込み）には paths を差し替える `typecheck:brand` スクリプトを別途用意する

## 影響（実装時の変更点）

- `apps/web/next.config.ts`: `KUKAN_BRAND` によるエイリアス切替（webpack / Turbopack）
- `apps/web/brands/example/`: スキャフォールド用サンプルの追加
- `apps/web/package.json` / prebuild: 静的アセットコピースクリプト
- `apps/web/tsconfig.json` / vitest 設定: `brands/` の include 追加
- `Dockerfile`: web ターゲットへの `ARG KUKAN_BRAND` 追加
- ドキュメント: フォーク向けカスタマイズガイドに複数ブランド手順を追記

## 関連

- ADR-023（ブランドオーバーライドレイヤー）: 本 ADR はその拡張。スロット機構・型変更ポリシー・テスト戦略はそのまま適用される
- ADR-041（マルチサイトデプロイ）: サイトごとの `KUKAN_BRAND` 指定でイメージを供給する
- ADR-036（ランタイムシステム設定）: 将来のデータ駆動化（選択肢 C）の受け皿
