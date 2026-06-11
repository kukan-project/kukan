# ADR-023: ブランドオーバーライドレイヤー

## ステータス

承認済み（2026-05-16）

## コンテキスト

KUKAN は複数の組織・自治体での導入を想定しており、本体リポジトリをフォークしてデザインカスタマイズを行う運用が発生する。ADR-010 の 3 段階テーマ戦略は方針として有効だが、**フォーク運用におけるコンフリクト回避**の具体策が未定だった。

### 課題

1. **マージコンフリクト**: フォーク側が `globals.css`、`layout.tsx`、`header.tsx` 等を直接変更すると、本体の更新を取り込む際に毎回コンフリクトが発生する
2. **Tier 2 の曖昧さ**: ADR-010 の Tier 2 は `apps/web-custom-*` として別アプリ化する構想だったが、`@kukan/web-core` パッケージ化が前提で実装コストが高い
3. **変更箇所の分散**: ロゴ、色、テキスト、コンポーネント構造の変更が複数ファイルに散在し、「何を変えたか」が不明確になる

### 要件

- フォーク側の変更を **1 ディレクトリに集約** し、本体ファイルへの直接変更を原則禁止
- CSS 変数（Tier 1）からコンポーネント差し替え（Tier 2）まで同一の仕組みでカバー
- 本体側のコンポーネント追加・修正がフォーク側に波及しない構造
- 型安全性を維持（オーバーライド可能なスロットが明示的）

## 決定

`apps/web/src/brand/` ディレクトリを**ブランドオーバーライドレイヤー**として新設し、自治体カスタマイズのすべてをこのディレクトリに閉じ込める。

## 根拠

### ディレクトリ構造

```
apps/web/
├── public/
│   └── brand/              ← 静的ファイル（ロゴ、ファビコン、OG 画像）
│       ├── logo.svg
│       ├── favicon.ico
│       └── og-image.png
└── src/
    ├── types/
    │   └── brand.ts        ← 型定義（本体側が管理、フォーク側は変更しない）
    ├── app/(brand)/[...slug]/
    │   └── page.tsx        ← 静的ページ用 catch-all ルート（本体側）
    └── brand/
        ├── index.ts        ← バレルエクスポート
        ├── theme.css       ← Tier 1: CSS 変数の上書き
        ├── brand-config.ts ← テキスト・メタデータ・ナビ項目等
        ├── messages/       ← i18n メッセージオーバーライド
        │   ├── ja.json    ← 日本語（上書きキーのみ記述）
        │   └── en.json    ← English（上書きキーのみ記述）
        ├── pages/          ← 静的ページ（利用規約等）
        │   ├── index.ts   ← ページ登録マップ
        │   └── terms.tsx   （サンプル、不要なら削除）
        └── overrides/      ← Tier 2: コンポーネントオーバーライド
            ├── index.ts    ← オーバーライド登録
            ├── header.tsx   （例）
            └── footer.tsx   （例）
```

### brand-config.ts

サイト全体のテキスト・メタデータを一箇所で管理する。本体のコンポーネントはこの設定値を参照する。

```typescript
import type { BrandConfig } from '@/types/brand'

export const brandConfig: BrandConfig = {
  // サイト基本情報
  siteName: 'KUKAN',
  siteDescription: 'Knowledge Unified Katalog And Network',
  copyright: 'KUKAN Contributors. AGPL-3.0 License.',
  copyrightUrl: 'https://github.com/kukan-project/kukan',

  // ロゴ
  logo: { type: 'default' },

  // ナビゲーション（追加項目）
  headerNavExtra: [],
  footerLinks: [{ label: '利用規約', href: '/terms' }],

  // メタデータ
  ogImage: '/og-default.png',
  faviconPath: '/favicon.ico',
}
```

### src/types/brand.ts（本体側が定義・管理）

```typescript
import type { ComponentType } from 'react'

/** ブランド設定の型定義 */
export interface BrandConfig {
  siteName: string
  siteDescription: string
  copyright: string
  copyrightUrl?: string
  logo: LogoConfig
  headerNavExtra: NavItem[]
  footerLinks: NavItem[]
  ogImage: string
  faviconPath: string
}

export interface NavItem {
  label: string
  href: string
  external?: boolean
}

export type LogoConfig =
  | { type: 'default' }
  | { type: 'image'; src: string; width: number; height: number; alt: string }

/** コンポーネントオーバーライドのスロット定義 */
export interface BrandOverrides {
  Header?: ComponentType
  Footer?: ComponentType
  TopPage?: ComponentType
  // 需要に応じて追加（型を追加しても既存フォークは壊れない）
}
```

### overrides/index.ts

本体のデフォルト:

```typescript
import type { BrandOverrides } from '@/types/brand'

export const overrides: BrandOverrides = {}
```

フォーク側の例:

```typescript
import type { BrandOverrides } from '@/types/brand'
import { Header } from './header'
import { Footer } from './footer'

export const overrides: BrandOverrides = {
  Header,
  Footer,
}
```

### 本体コンポーネントでの消費パターン

オーバーライドチェックはコンポーネント自身に内包する。別途 slot ファイルは作らない。

```typescript
// apps/web/src/components/layout/header.tsx（本体側）
import { overrides } from '@/brand'

export async function Header() {
  const Custom = overrides.Header
  if (Custom) return <Custom />
  return <DefaultHeader />
}

export async function DefaultHeader() {
  // ...デフォルト実装
}
```

```typescript
// apps/web/src/app/page.tsx（本体側）
import { overrides } from '@/brand'

export default async function HomePage() {
  const Custom = overrides.TopPage
  if (Custom) return <Custom />
  // ...デフォルト実装
}
```

```typescript
// apps/web/src/app/layout.tsx（本体側）
import { brandConfig } from '@/brand'
import { Header } from '@/components/layout/header'
import { Footer } from '@/components/layout/footer'
import '@/brand/theme.css'

export const metadata: Metadata = {
  title: brandConfig.siteName,
  description: brandConfig.siteDescription,
  icons: { icon: brandConfig.faviconPath },
  openGraph: { images: [brandConfig.ogImage] },
}
```

フォーク側のカスタムコンポーネントは `DefaultHeader` / `DefaultFooter` を部品再利用できる。
循環参照を避けるため、`Header` / `Footer` ではなく `Default*` を使用すること。

### theme.css

本体のデフォルト（空、または KUKAN デフォルト値を再宣言）:

```css
/* Brand theme overrides */
/* フォーク側でここに CSS 変数を記述 */
```

フォーク側の例:

```css
:root {
  --primary: 142 64% 32%; /* 組織のブランドカラー */
  --primary-foreground: 0 0% 100%;
  --kukan-header-height: 72px;
}
```

### i18n メッセージオーバーライド

`brand/messages/{locale}.json` に上書きしたいキーだけを記述する。`src/i18n/request.ts` がデフォルトメッセージ（`messages/{locale}.json`）とブランド側メッセージをディープマージする。ブランド側ファイルが空オブジェクト `{}` の場合はマージ処理をスキップし、既存動作と同一になる。

本体のデフォルト:

```json
{}
```

フォーク側の例（`brand/messages/ja.json`）:

```json
{
  "home": {
    "title": "○○市オープンデータカタログ",
    "description": "○○市のオープンデータを検索・活用できるポータル"
  }
}
```

- 記述したキーのみ上書きされ、記述しなかったキーはデフォルトが維持される
- ネストされたオブジェクトは再帰的にマージされる（兄弟キーは保持）
- `brandConfig.siteName` 等の言語非依存設定と i18n メッセージの使い分け: メタデータ・OGP 等の言語切替が不要な値は `brandConfig` に、UI 表示テキストは i18n メッセージに配置する

### コンフリクト回避の仕組み

| ファイル                       | 本体側の変更頻度                 | フォーク側の変更 | コンフリクトリスク         |
| ------------------------------ | -------------------------------- | ---------------- | -------------------------- |
| `types/brand.ts`               | 低（スロット追加時のみ）         | 変更しない       | なし（型追加は後方互換）   |
| `brand/brand-config.ts`        | 変更しない（デフォルト値は固定） | **変更する**     | **極低**（本体は触らない） |
| `brand/theme.css`              | 変更しない                       | **変更する**     | **極低**                   |
| `brand/overrides/index.ts`     | 変更しない（空オブジェクト）     | **変更する**     | **極低**                   |
| `brand/overrides/*.tsx`        | 存在しない                       | **新規追加**     | **なし**                   |
| `brand/messages/*.json`        | 変更しない（空オブジェクト）     | **変更する**     | **極低**                   |
| `brand/pages/index.ts`         | サンプルのみ                     | **変更する**     | **極低**                   |
| `brand/pages/*.tsx`            | サンプルのみ                     | **追加/削除**    | **極低**                   |
| `public/brand/*`               | デフォルトのみ                   | **差し替え**     | **極低**                   |
| `app/page.tsx`                 | 通常通り開発                     | 変更しない       | なし                       |
| `components/layout/header.tsx` | 通常通り開発                     | 変更しない       | なし                       |
| `app/globals.css`              | 通常通り開発                     | 変更しない       | なし                       |

### オーバーライドコンポーネントからの本体再利用

フォーク側のカスタムコンポーネントは、本体のデフォルトコンポーネントや部品をインポートして再利用できる。全面差し替えではなく部分変更が可能。

```typescript
// brand/overrides/header.tsx（フォーク側）
import { getCurrentUser } from '@/lib/server-api'
import { LanguageSwitcher } from '@/components/layout/language-switcher'
import { MobileNav } from '@/components/layout/mobile-nav'
import { UserMenu } from '@/components/auth/user-menu'

export async function Header() {
  const user = await getCurrentUser()

  return (
    <header className="sticky top-0 z-40 bg-[hsl(var(--primary))]">
      <div className="mx-auto flex h-[var(--kukan-header-height)] max-w-[var(--kukan-container-max-width)] items-center justify-between px-4">
        <img src="/brand/logo.svg" alt="オープンデータカタログ" className="h-8" />
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          {user && <UserMenu user={user} />}
          <MobileNav user={user} />
        </div>
      </div>
    </header>
  )
}
```

### ADR-010 との関係

本 ADR は ADR-010 の Tier 1・Tier 2 を**具体化・置換**する。

| ADR-010（旧）                              | ADR-023（新）                                         |
| ------------------------------------------ | ----------------------------------------------------- |
| Tier 1: `CUSTOM_THEME_URL` で外部 CSS 注入 | `brand/theme.css` にフォーク側が直接記述              |
| Tier 2: `apps/web-custom-*` で別アプリ化   | `src/brand/` ディレクトリで同一アプリ内オーバーライド |
| `@kukan/web-core` パッケージ化が前提       | パッケージ化不要、即座に利用可能                      |
| フォークとの関係が不明確                   | フォーク運用を前提に設計                              |

Tier 3（プラグインシステム）は ADR-010 の方針をそのまま維持する。

## フォーク運用ルール

1. **フォーク側の変更は `src/brand/` に限定する**（原則）
2. **`src/brand/` 外のファイルを変更する必要がある場合**、本体に「カスタマイズポイントの追加」をPR する
3. **本体側は `src/brand/` 内のデフォルト値ファイルを変更しない**（`src/types/brand.ts` の型追加は許可）
4. **新しいオーバーライドスロットが必要な場合**、本体の `BrandOverrides` 型にキーを追加し、対応するコンポーネントにオーバーライドチェックを組み込む
5. **フォーク側は定期的に本体の main ブランチを rebase/merge する**（`src/brand/` が分離されているのでコンフリクトは原則発生しない）

## 型変更ポリシー

型定義（`src/types/brand.ts`）は本体側が管理する。フォークの `brand-config.ts` / `overrides/index.ts` を壊さないよう、以下のルールに従う。

### 非破壊的変更（通常リリースで実施可）

- `BrandOverrides` へのオプショナルスロット追加 — フォークの `{}` は型エラーにならない
- `BrandConfig` へのオプショナルフィールド追加 — フォーク側は記述不要

```typescript
// 新規フィールドは常にオプショナルで追加
export interface BrandConfig {
  // ...既存フィールド
  showBreadcrumb?: boolean // ← 新規
}

// 消費側で ?? によりデフォルト値を適用
const show = brandConfig.showBreadcrumb ?? true
```

### 破壊的変更（CHANGELOG / migration guide で明示）

- `BrandConfig` への必須フィールド追加 — フォークの `brand-config.ts` で型エラーが発生
- 既存フィールドの型変更・リネーム・削除

破壊的変更が必要な場合は、リリースノートにフォーク側の対応手順を記載する。

## 実装計画

### Step 1（即時、本体側）

1. `apps/web/src/brand/` ディレクトリを作成し、デフォルト値で初期化
2. `src/types/brand.ts` に型定義を配置（本体管理、`brand/` とは分離）
3. `layout.tsx` から `brandConfig` を参照するよう変更
4. Header / Footer を slot 化（`HeaderSlot`, `FooterSlot`）

### Step 2（フォーク着手時）

5. フォーク側で `brand-config.ts` を組織用に編集
6. `brand/theme.css` にカラーパレットを定義
7. 必要に応じて `overrides/` にカスタムコンポーネントを追加

### Step 3（将来、複数自治体展開時）

8. `brand/` のテンプレートジェネレーター（scaffolding CLI）を検討
9. オーバーライドスロットの拡充（検索ページ、ダッシュボード等）。TopPage スロットは Step 1 で実装済み

## 結果

### メリット

1. **コンフリクトゼロ**: フォーク側の変更が `src/brand/` に閉じるため、本体更新時にコンフリクトが発生しない
2. **型安全**: `BrandOverrides` と `BrandConfig` の型定義により、利用可能なカスタマイズポイントが IDE で補完される
3. **段階的カスタマイズ**: CSS 変数のみ（5分）→ テキスト変更（30分）→ コンポーネント差し替え（数時間）と段階的に対応可能
4. **本体開発への影響ゼロ**: slot パターンにより、デフォルト動作は既存コンポーネントそのもの
5. **透明性**: git diff で「フォーク固有の変更」が `src/brand/` だけに集約され、レビューが容易

### デメリット

1. **間接参照の増加**: Header → overrides → Header と 1 レイヤー増える
2. **スロット追加の手間**: 新しいカスタマイズポイントを追加するたびに本体側の作業が必要
3. **全面カスタマイズの制約**: ページ構成を根本から変えたい場合はこの仕組みでは対応困難（その場合は別 app 化を検討）

### 中立

1. **`src/brand/` は Git 管理対象**: `.gitignore` しない（フォーク間の差分として正しく追跡される）
2. **デフォルト値はコミット済み**: 本体リポジトリに KUKAN デフォルトの `brand-config.ts` が存在する（空ではない）

## 参考資料

- ADR-010: shadcn/ui テーマ戦略（本 ADR で Tier 2 を具体化）
- WordPress テーマ子テーマパターン（オーバーライドの概念参考）
- Next.js App Router レイアウトシステム

## 関連 ADR

- ADR-010: shadcn/ui テーマ戦略（Tier 2 を本 ADR で置換）
- ADR-008: Turborepo モノレポ
