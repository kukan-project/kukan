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
apps/web/src/brand/
├── theme.css               ← Tier 1: CSS 変数の上書き
├── brand-config.ts         ← テキスト・メタデータ・ナビ項目等
├── assets/                 ← ロゴ画像、ファビコン、OG 画像
│   ├── logo.svg
│   ├── favicon.ico
│   └── og-image.png
└── overrides/              ← Tier 2: コンポーネントオーバーライド
    ├── index.ts            ← オーバーライド登録（唯一の編集対象）
    ├── header.tsx           （例）
    ├── footer.tsx           （例）
    └── hero-section.tsx     （例）
```

### brand-config.ts

サイト全体のテキスト・メタデータを一箇所で管理する。本体のコンポーネントはこの設定値を参照する。

```typescript
import type { BrandConfig } from './types'

export const brandConfig: BrandConfig = {
  // サイト基本情報
  siteName: 'KUKAN',
  siteDescription: 'オープンデータカタログ',
  copyright: '© KUKAN Contributors',
  copyrightUrl: 'https://github.com/kukan-project/kukan',

  // ロゴ
  logo: {
    type: 'default', // 'default' | 'image' | 'component'
    // image の場合: src, width, height を指定
    // component の場合: overrides/logo.tsx を参照
  },

  // ナビゲーション（追加項目）
  headerNavExtra: [],
  footerLinks: [],

  // メタデータ
  ogImage: '/og-default.png',
  faviconPath: '/favicon.ico',
}
```

### brand/types.ts（本体側が定義・管理）

```typescript
import type { ComponentType, ReactNode } from 'react'

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
  | { type: 'component' }

/** コンポーネントオーバーライドのスロット定義 */
export interface BrandOverrides {
  Header?: ComponentType
  Footer?: ComponentType
  Logo?: ComponentType<{ className?: string }>
  HeroSection?: ComponentType
  // 需要に応じて追加（型を追加しても既存フォークは壊れない）
}
```

### overrides/index.ts

本体のデフォルト:

```typescript
import type { BrandOverrides } from '../types'

export const overrides: BrandOverrides = {}
```

フォーク側の例:

```typescript
import type { BrandOverrides } from '../types'
import { CustomHeader } from './header'
import { CustomFooter } from './footer'

export const overrides: BrandOverrides = {
  Header: CustomHeader,
  Footer: CustomFooter,
}
```

### 本体コンポーネントでの消費パターン

```typescript
// apps/web/src/components/layout/header-slot.tsx（本体側）
import { overrides } from '@/brand/overrides'
import { DefaultHeader } from './header'

export function HeaderSlot() {
  const Custom = overrides.Header
  if (Custom) return <Custom />
  return <DefaultHeader />
}
```

```typescript
// apps/web/src/app/layout.tsx（本体側）
import { brandConfig } from '@/brand/brand-config'
import '@/brand/theme.css'

export const metadata = {
  title: brandConfig.siteName,
  description: brandConfig.siteDescription,
  // ...
}
```

### theme.css

本体のデフォルト（空、または KUKAN デフォルト値を再宣言）:

```css
/* Brand theme overrides */
/* フォーク側でここに CSS 変数を記述 */
```

フォーク側の例:

```css
:root {
  --primary: 142 64% 32%;       /* 組織のブランドカラー */
  --primary-foreground: 0 0% 100%;
  --kukan-header-height: 72px;
}
```

### コンフリクト回避の仕組み

| ファイル | 本体側の変更頻度 | フォーク側の変更 | コンフリクトリスク |
|----------|------------------|------------------|--------------------|
| `brand/types.ts` | 低（スロット追加時のみ） | 変更しない | なし（型追加は後方互換） |
| `brand/brand-config.ts` | 変更しない（デフォルト値は固定） | **変更する** | **極低**（本体は触らない） |
| `brand/theme.css` | 変更しない | **変更する** | **極低** |
| `brand/overrides/index.ts` | 変更しない（空オブジェクト） | **変更する** | **極低** |
| `brand/overrides/*.tsx` | 存在しない | **新規追加** | **なし** |
| `brand/assets/*` | デフォルトのみ | **差し替え** | **極低** |
| `components/layout/header.tsx` | 通常通り開発 | 変更しない | なし |
| `app/globals.css` | 通常通り開発 | 変更しない | なし |

### オーバーライドコンポーネントからの本体再利用

フォーク側のカスタムコンポーネントは、本体のデフォルトコンポーネントや部品をインポートして再利用できる。全面差し替えではなく部分変更が可能。

```typescript
// brand/overrides/header.tsx（フォーク側）
import { DefaultNav, DefaultUserMenu } from '@/components/layout/header'

export function CustomHeader() {
  return (
    <header className="sticky top-0 z-40 bg-[hsl(var(--primary))]">
      <div className="mx-auto flex h-[var(--kukan-header-height)] max-w-[var(--kukan-container-max-width)] items-center px-4">
        <img src="/brand/logo.svg" alt="オープンデータカタログ" className="h-8" />
        <DefaultNav />
        <DefaultUserMenu />
      </div>
    </header>
  )
}
```

### ADR-010 との関係

本 ADR は ADR-010 の Tier 2 を**具体化・置換**する。

| ADR-010 Tier 2（旧） | ADR-023（新） |
|----------------------|---------------|
| `apps/web-custom-*` で別アプリ化 | `src/brand/` ディレクトリで同一アプリ内オーバーライド |
| `@kukan/web-core` パッケージ化が前提 | パッケージ化不要、即座に利用可能 |
| フォークとの関係が不明確 | フォーク運用を前提に設計 |

Tier 1（CSS変数）と Tier 3（プラグインシステム）は ADR-010 の方針をそのまま維持する。

## フォーク運用ルール

1. **フォーク側の変更は `src/brand/` に限定する**（原則）
2. **`src/brand/` 外のファイルを変更する必要がある場合**、本体に「カスタマイズポイントの追加」をPR する
3. **本体側は `src/brand/` 内のデフォルト値ファイルを変更しない**（`types.ts` の型追加は許可）
4. **新しいオーバーライドスロットが必要な場合**、本体の `BrandOverrides` 型にキーを追加し、対応する `*-slot.tsx` を作成する
5. **フォーク側は定期的に本体の develop ブランチを rebase/merge する**（`src/brand/` が分離されているのでコンフリクトは原則発生しない）

## 実装計画

### Step 1（即時、本体側）

1. `apps/web/src/brand/` ディレクトリを作成し、デフォルト値で初期化
2. `brand/types.ts` を定義
3. `layout.tsx` から `brandConfig` を参照するよう変更
4. Header / Footer を slot 化（`HeaderSlot`, `FooterSlot`）

### Step 2（フォーク着手時）

5. フォーク側で `brand-config.ts` を組織用に編集
6. `brand/theme.css` にカラーパレットを定義
7. 必要に応じて `overrides/` にカスタムコンポーネントを追加

### Step 3（将来、複数自治体展開時）

8. `brand/` のテンプレートジェネレーター（scaffolding CLI）を検討
9. オーバーライドスロットの拡充（検索ページ、ダッシュボード等）

## 結果

### メリット

1. **コンフリクトゼロ**: フォーク側の変更が `src/brand/` に閉じるため、本体更新時にコンフリクトが発生しない
2. **型安全**: `BrandOverrides` と `BrandConfig` の型定義により、利用可能なカスタマイズポイントが IDE で補完される
3. **段階的カスタマイズ**: CSS 変数のみ（5分）→ テキスト変更（30分）→ コンポーネント差し替え（数時間）と段階的に対応可能
4. **本体開発への影響ゼロ**: slot パターンにより、デフォルト動作は既存コンポーネントそのもの
5. **透明性**: git diff で「フォーク固有の変更」が `src/brand/` だけに集約され、レビューが容易

### デメリット

1. **間接参照の増加**: Header → HeaderSlot → overrides → CustomHeader と 1 レイヤー増える
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
