# ADR-023: ブランドオーバーライドレイヤー

## ステータス

承認済み（2026-05-16、2026-07-10 テスト戦略を追記、2026-07-16 トークン運用ポリシーを追記、2026-09-02 ロケール別ブランドテキストを追記）

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
  footerLinks: [{ label: { ja: '利用規約', en: 'Terms of Use' }, href: '/terms' }],

  // メタデータ
  ogImage: '/og-default.png',
  faviconPath: '/favicon.ico',
}
```

### src/types/brand.ts（本体側が定義・管理）

```typescript
import type { ComponentType } from 'react'
import type { LocalizedText } from '@/i18n/locales'

/** ブランド設定の型定義 */
export interface BrandConfig {
  siteName: LocalizedText
  siteDescription: LocalizedText
  copyright: LocalizedText
  copyrightUrl?: string
  logo: LogoConfig
  headerNavExtra: NavItem[]
  footerLinks: NavItem[]
  ogImage: string
  faviconPath: string
}

export interface NavItem {
  label: LocalizedText
  href: string
  external?: boolean
}

export type LogoConfig =
  | { type: 'default' }
  | { type: 'image'; src: string; width: number; height: number; alt: LocalizedText }

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
import { getLocale } from 'next-intl/server'
import { brandConfig } from '@/brand'
import { resolveBrandConfig } from '@/lib/resolved-brand'
import { Header } from '@/components/layout/header'
import { Footer } from '@/components/layout/footer'
import '@/brand/theme.css'

// ロケール非依存の部分はモジュールスコープで一度だけ構築
const staticMetadata: Metadata = {
  icons: { icon: brandConfig.faviconPath },
  openGraph: { images: [brandConfig.ogImage] },
}

export async function generateMetadata(): Promise<Metadata> {
  const brand = resolveBrandConfig(await getLocale())
  return { ...staticMetadata, title: brand.siteName, description: brand.siteDescription }
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
- `brandConfig` と i18n メッセージの使い分け: ブランド固有の値（サイト名・ナビ項目・著作権表示等）は `brandConfig` に、本体 UI の翻訳テキストの上書きは i18n メッセージに配置する

### ロケール別ブランドテキスト（2026-09-02 追記）

`brandConfig` のユーザー向けテキスト（`siteName` / `siteDescription` / `copyright` /
`logo.alt` / `headerNavExtra[].label` / `footerLinks[].label`）は
`LocalizedText`（`string | Partial<Record<SupportedLocale, string>>`）を受け付ける。
文字列のままなら全ロケール共通（後方互換）、ロケールマップならロケール切替に追従する。
欠けたロケールはデフォルトロケール → 宣言順で最初に定義されたロケールの順で
フォールバックする。解決は本体側の `resolveBrandConfig()`（`src/lib/resolved-brand.ts`。
全フィールドを解決済み文字列にしたブランド設定を返す）が行い、フォーク側は値を
書くだけでよい。静的ページ（`brand/pages/`）の本文と metadata はこの機構の対象外
（ページ自体がフォーク所有のため、多言語化はフォーク側の実装に委ねる）。

この型拡張は、`brandConfig` のテキストフィールドを**直接描画している**フォークの
カスタムコンポーネントには破壊的変更である（設定値が文字列のままでも
`{brandConfig.siteName}` は `LocalizedText` 型のため型エラーになる）。後述の
型変更ポリシー「破壊的変更」に該当し、移行は `resolveBrandConfig()` 経由に
切り替える:

```tsx
// async サーバーコンポーネント: getLocale（next-intl/server）
const brand = resolveBrandConfig(await getLocale())
```

```tsx
// クライアント / 非 async サーバーコンポーネント: useLocale（next-intl）
const brand = resolveBrandConfig(useLocale())
```

いずれも `brand.siteName` / `brand.footerLinks[].label` 等は解決済みの string になる。

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
6. **フォーク側は本体のテストファイルを変更しない**（後述「テスト戦略」により本体テストはブランド非依存に保たれるため、変更は不要のはず。フォークのカスタマイズで本体テストが壊れる場合は本体側のバグとして issue / PR で報告する）

## トークン運用ポリシー

フォークの実運用から次のフィードバックを得た: (1) 公式トークンがどのコンポーネント・どの状態で使われているか分からず、上書き可否の判断に毎回ソース調査が必要、(2) 公式トークンはほぼすべて複数箇所で共有されており、実質的に自由に上書きできる範囲が狭い、(3) デザイナー指定の配色には公式トークンの役割に当てはまらない独自色が含まれ、公式ルールの範囲内ではデザインを再現しきれない。これを受け、CSS 変数（トークン）の運用ルールを以下のとおり定める。

### 名前空間の予約

| プレフィックス                  | 管理者   | 用途                                                                     |
| ------------------------------- | -------- | ------------------------------------------------------------------------ |
| shadcn 標準名（`--primary` 等） | 本体     | セマンティックトークン。フォークは値の上書きのみ可                       |
| `--kukan-*`                     | 本体     | KUKAN 固有のレイアウト値・エイリアストークン。フォークは値の上書きのみ可 |
| `--brand-*`                     | フォーク | フォーク独自トークン。**本体は `--brand-*` を定義も参照もしない**        |

### フォーク独自トークン（`--brand-*`）

デザイナー指定の配色が公式トークンの役割（主要色・強調色等）に当てはまらない場合、フォークは `brand/theme.css` に `--brand-*` トークンを自由に追加できる。

- 形式は公式トークンと同じ HSL 裸トリプレットを推奨（使用側で `/10` 等の透過を掛けられる）
- 消費できるのはフォーク所有のコンポーネント（`brand/overrides/` / `brand/pages/`）内のみ。本体コンポーネントは参照しない
- `brand/theme.css` は `globals.css` と別の CSS ユニットであり Tailwind の `@theme` によるユーティリティ生成が効かないため、arbitrary value 記法（`bg-[hsl(var(--brand-xxx))]`）で参照することを公式の作法とする

### エイリアストークン（本体側、オンデマンド追加）

公式トークンの単独上書きでは意図しない箇所（ボタンのホバー、ドロップダウンの選択状態等）に波及するため、オーバーライドしていない本体画面の特定コンポーネントだけ色を変えたい需要には、本体がコンポーネントスコープの**エイリアストークン**を追加して応える。

```css
/* globals.css（本体） */
:root {
  /* デフォルトは公式トークンを参照 */
  --kukan-header-bg: var(--primary);
}

@theme inline {
  /* ユーティリティクラス bg-kukan-header-bg を生成 */
  --color-kukan-header-bg: hsl(var(--kukan-header-bg));
}
```

- デフォルト値は公式トークンの参照とし、フォークが上書きしない限り挙動は変わらない
- `:root` への定義だけではユーティリティクラスは生成されない。`globals.css` の `@theme inline` に `--color-*` マッピングをセットで追加する（`brand/theme.css` と異なり `globals.css` では `@theme` が機能する）
- 事前の網羅定義はしない（ADR-010 の YAGNI 原則）。フォーク運用ルール 2「カスタマイズポイントの追加 PR」の対象として、需要が生じた箇所から追加する

### トークンの使用箇所ドキュメント

上書き可否の調査コストを下げるため、以下を整備する。

1. **上書きサポート区分** — 外観カスタマイズガイドのトークン表に「推奨（ブランド変更を想定）/ 注意（影響範囲が広い。代表的な使用箇所・状態を併記）/ 非推奨（エラー・成功等の意味色）」を明記する（実施済み）
2. **使用箇所リファレンスの自動生成**（フォローアップ） — Tailwind のクラス名は variant prefix（`hover:` / `focus-visible:` / `data-[state=...]:`）に状態情報を含むため、grep ベースで「トークン → コンポーネント → 状態」の一覧を機械生成できる。手書きの網羅表は陳腐化するため作らない
3. **ビジュアル確認ページ**（将来検討） — テーマ変更の影響を全コンポーネント・全状態で目視確認できるギャラリー

## テスト戦略

フォークがブランドをカスタマイズすると、スロットコンポーネント（`Header` / `Footer` / `HomePage`）を render する本体のユニットテストがカスタム実装を描画してしまい、KUKAN デフォルトの文言・構造への期待が破綻する。これを防ぐため、**本体のテストはブランド非依存（KUKAN デフォルト固定）とする**。

1. **本体テストは `@/brand` を実 import しない**。ブランド消費コンポーネントを render するテストは、ブランドモジュールをモックして KUKAN デフォルト値に固定する。本体の `resolveBrandConfig()` はバレルを経由せず `@/brand/brand-config` を直接 import する（フォークの overrides をクライアントバンドルに巻き込まないため）ので、**両方**をモックする:

   ```typescript
   vi.mock('@/brand', () => import('@/__tests__/brand-defaults'))
   vi.mock('@/brand/brand-config', () => import('@/__tests__/brand-defaults'))
   ```

2. **`src/__tests__/brand-defaults.ts` は本体が管理する**。KUKAN デフォルト値の意図的なコピーであり、`src/brand/brand-config.ts` から import しない（フォークが書き換えるため）。`BrandConfig` に必須フィールドを追加する際は、このファイルも本体側で更新する。
3. **スロット機構自体のテストは本体が持つ**（`brand-slots.test.tsx`）。ダミーのオーバーライドを登録した状態で「カスタムが優先される」ことだけを検証し、フォークの実装内容には依存しない。
4. **フォーク独自コンポーネントのテストは `src/brand/__tests__/` に置く**。vitest の include パターン（`src/**/__tests__/**/*.test.{ts,tsx}`）で自動発見されるため設定変更は不要。テストを書くかどうか・何を検証するかはフォークの裁量。
5. **i18n はすでにブランド非依存**。テストの `setup.ts` はデフォルトの `messages/en.json` を直接参照するため、`brand/messages/` の上書きはテストに影響しない。

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

- ADR-042: マルチブランドビルド（本 ADR の拡張。フォーク内に複数ブランドを持てる選択機構を追加）
- ADR-010: shadcn/ui テーマ戦略（Tier 2 を本 ADR で置換）
- ADR-008: Turborepo モノレポ
