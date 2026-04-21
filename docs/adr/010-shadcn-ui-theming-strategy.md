# ADR-010: shadcn/ui テーマ戦略

## ステータス

承認済み（2026-03-03）

## コンテキスト

KUKAN は日本の自治体向けデータカタログプラットフォームであり、各自治体で異なるブランディング要件（色、ロゴ、レイアウト）が存在する。以下のバランスを取ったテーマ戦略が必要：

1. **カスタマイズの容易性**: 深い技術知識なしに自治体がブランディング可能
2. **保守性**: コアの更新とカスタマイズを分離
3. **型安全性**: カスタマイズ時も TypeScript の恩恵を維持
4. **段階的拡張**: 簡易なカスタマイズはビルド不要、高度なカスタマイズにも対応

CKAN のテンプレート階層（デフォルト → エクステンション → カスタム）は参考になるが、KUKAN のモダンアーキテクチャ（API分離、React、TypeScript）には異なるアプローチが必要。

## 検討した選択肢

### A) Material-UI (MUI)

- 良い点: 大規模エコシステム、豊富なコンポーネント、テーマシステム完備
- 問題点:
  - 依存関係が重い（バンドルサイズ増大）
  - スタイルカスタマイズが複雑（CSS-in-JS、sx prop）
  - Next.js App Router との統合に制約
  - コンポーネントがブラックボックス（内部実装の変更が困難）

### B) Ant Design

- 良い点: 管理画面向けコンポーネントが豊富、テーマ変数システム
- 問題点:
  - デザインが中国風（日本の自治体向けに調整が必要）
  - Less から CSS-in-JS への移行期で不安定
  - React Server Components 対応が未成熟
  - カスタマイズの自由度が低い

### C) Chakra UI

- 良い点: コンポーネント単位でのカスタマイズ性、CSS Variables サポート
- 問題点:
  - v3 でアーキテクチャ刷新中（安定性の懸念）
  - バンドルサイズがやや大きい
  - Tailwind との併用が推奨されない

### D) shadcn/ui + Tailwind CSS 4 — 採用

- 良い点:
  - **コピー&ペーストアプローチ**: コンポーネントがプロジェクトに直接配置され、完全な所有権
  - **Radix UI ベース**: アクセシビリティ（WCAG準拠）が標準搭載
  - **Tailwind CSS 統合**: ユーティリティファーストで柔軟なスタイリング
  - **CSS Variables**: ランタイムでのテーマ変更が容易
  - **型安全性**: TypeScript の恩恵を完全に享受
  - **React Server Components 対応**: Next.js 16 App Router と完全互換
  - **軽量**: 必要なコンポーネントだけ配置、依存関係最小限
- 問題点:
  - 手動更新: shadcn/ui の更新は自動適用されない（コピーなので）
  - Tailwind への依存: Tailwind を使わないプロジェクトでは使用不可
  - 学習コスト: Tailwind CSS の理解が必要

## 決定

**shadcn/ui** を UI コンポーネント基盤として採用し、**3段階テーマ戦略**を実装する。

## 根拠

### 技術スタック

1. **shadcn/ui** - コンポーネントコレクション
   - コピー&ペーストアプローチ（ライブラリではない）
   - Radix UI（アクセシビリティ）+ Tailwind CSS（スタイリング）+ CVA（バリアント管理）
   - 完全な所有権とカスタマイズの自由

2. **Tailwind CSS 4** - ユーティリティファーストCSSフレームワーク
   - CSS-first 設定（`@theme` ディレクティブ）
   - ネイティブ CSS Variables サポート
   - Rust ベースエンジンによる高速化

3. **CSS Variables** - ビルド不要のランタイムテーマ変更
   - HSL カラーフォーマット（操作が容易）
   - shadcn/ui 規約: `--primary`, `--secondary` など
   - KUKAN 固有変数: `--kukan-` プレフィックス

### 3段階テーマ戦略

```
┌─────────────────────────────────────────┐
│ Tier 1: CSS Variables（ランタイム）    │ ← 80% のユースケース
│  - 配色、スペーシング、タイポグラフィ  │
│  - ビルド不要                          │
│  - 環境変数によるインジェクション      │
├─────────────────────────────────────────┤
│ Tier 2: Theme Package（ビルド時）      │ ← 15% のユースケース
│  - コンポーネントレベルのオーバーライド│
│  - レイアウトカスタマイズ              │
│  - apps/web を fork → apps/web-custom-* │
├─────────────────────────────────────────┤
│ Tier 3: Plugin System（将来）          │ ← 5% のユースケース
│  - カスタムページと機能追加            │
│  - Phase 3+ で検討                     │
└─────────────────────────────────────────┘
```

#### Tier 1: CSS Variables（Phase 1）

**実装:**

```css
/* apps/web/app/globals.css */
@layer base {
  :root {
    /* shadcn/ui デフォルト変数 */
    --background: 0 0% 100%;
    --foreground: 222.2 47.4% 11.2%;
    --primary: 221.2 83.2% 53.3%; /* KUKAN Blue */
    --secondary: 210 40% 96.1%;
    --radius: 0.5rem;

    /* KUKAN 固有変数（必要になったら追加） */
    --kukan-header-height: 4rem;
    --kukan-logo-height: 2.5rem;
    --kukan-container-max-width: 1280px;
  }
}
```

**カスタマイズ方法:**

```typescript
// apps/web/app/layout.tsx
export default function RootLayout({ children }) {
  const customThemeUrl = process.env.CUSTOM_THEME_URL

  return (
    <html>
      <head>
        {customThemeUrl && <link rel="stylesheet" href={customThemeUrl} />}
      </head>
      <body>{children}</body>
    </html>
  )
}
```

自治体は CSS ファイルを用意:

```css
/* https://tokyo.example.jp/kukan-theme.css */
:root {
  --primary: 0 72% 51%; /* 東京都の赤 */
  --kukan-header-height: 5rem;
}
```

**メリット:**

- ビルド不要
- シンプルなデプロイ（CSS ファイルをホスティングするだけ）
- ほとんどのブランディング要件をカバー（色、スペーシング、タイポグラフィ）

**制約:**

- コンポーネント構造やレイアウトは変更不可

#### Tier 2: Theme Package（Phase 2+）

より深いカスタマイズが必要な自治体向け:

```
apps/web-custom-tokyo/
├── components/
│   ├── Header.tsx           # 特定コンポーネントをオーバーライド
│   └── Footer.tsx
├── app/
│   └── layout.tsx           # カスタムレイアウト
├── tailwind.config.ts       # カスタムテーマ設定
└── package.json
    {
      "dependencies": {
        "@kukan/web-core": "^1.0.0",  # 将来: apps/web をパッケージ化
        "@kukan/ui": "workspace:*"
      }
    }
```

**オーバーライドパターン:**

```typescript
// apps/web-custom-tokyo/components/Header.tsx
import { Header as DefaultHeader } from '@kukan/web-core/components/Header'

export function Header() {
  return (
    <DefaultHeader
      logoSrc="/tokyo-logo.svg"
      primaryColor="red"
    >
      <CustomNav /> {/* 独自要素追加 */}
    </DefaultHeader>
  )
}
```

**メリット:**

- TypeScript の型安全性を維持
- 部分的オーバーライド（必要な部分だけ変更）
- コンポーネントレベルのカスタマイズ

**トレードオフ:**

- ビルドステップが必要
- 自治体側に基本的な Node.js 知識が必要

#### Tier 3: Plugin System（Phase 3+、オプション）

高度なユースケース向け（カスタム機能、サードパーティ統合）:

```typescript
// コンセプト API（Phase 1 では未実装）
const plugins = await loadPlugins(process.env.KUKAN_PLUGINS?.split(','))

export default function RootLayout({ children }) {
  return (
    <PluginProvider plugins={plugins}>
      {children}
    </PluginProvider>
  )
}
```

**実装を延期する条件:**

- 複数の自治体からカスタム機能要望が出るまで
- 拡張性ニーズの明確なパターンが見えるまで

### 変数命名規則

**shadcn/ui 変数**（そのまま使用）:

- `--background`, `--foreground`
- `--primary`, `--secondary`, `--muted`, `--accent`
- `--border`, `--input`, `--ring`
- `--radius`

**KUKAN 固有変数**（必要な時のみ追加）:

- プレフィックス: `--kukan-`
- 例: `--kukan-header-height`, `--kukan-logo-height`
- 原則: **YAGNI**（You Ain't Gonna Need It） - 実際に必要になってから追加

**避けるべきこと:**

- ❌ 過剰設計: 100個以上の変数を事前定義
- ❌ 重複管理: Tailwind config と CSS Variables の二重管理
- ❌ 未使用変数: 「念のため」で変数を作成

### ドキュメント要件

`docs/customization.md` を作成し、以下を記載:

1. 利用可能な CSS 変数とその効果
2. サンプルテーマ CSS ファイル
3. Tier 2 Theme Package ガイド（実装時）
4. Tier 間の移行ガイド

## 結果

### メリット

1. **段階的カスタマイズパス**: シンプル（CSS）から高度（Theme Package）へ進める
2. **ベンダーロックインなし**: コンポーネントが自プロジェクトにあり、完全カスタマイズ可能
3. **型安全性**: カスタマイズ時も TypeScript の intellisense が機能
4. **アクセシビリティ組み込み**: Radix UI により WCAG 準拠
5. **モダンスタック**: React Server Components、Next.js 16 互換
6. **Storybook 統合**: 自治体向けコンポーネントカタログが容易

### デメリット

1. **学習コスト**: Tier 2+ では Tailwind CSS の知識が必要
2. **手動更新**: shadcn/ui の更新は手動で再コピーが必要
3. **ビルド複雑性**: Tier 2 カスタマイズには Node.js ツールチェーンが必要

### 中立

1. **Tailwind 依存**: テーマシステム全体が Tailwind CSS に依存（プロジェクト要件として許容）
2. **CSS Variables フォーマット**: HSL 形式は不慣れかもしれない（shadcn/ui で十分ドキュメント化されている）

## 実装計画

### Phase 1（現在）:

1. `packages/ui` を shadcn/ui でセットアップ

   ```bash
   cd packages/ui
   npx shadcn@latest init
   npx shadcn@latest add button card badge dialog input table
   ```

2. `apps/web/app/globals.css` で CSS Variables を定義
   - shadcn/ui デフォルト
   - KUKAN 固有変数を最小限（5〜10個）

3. `packages/ui/src/components/catalog/` に KUKAN カタログコンポーネントを作成
   - DatasetCard, ResourceList, OrganizationBadge など

4. Storybook でコンポーネントドキュメント化

### Phase 2（初回カスタマイズ需要発生時）:

5. `apps/web` を `@kukan/web-core` パッケージとして切り出し
6. `apps/web-custom-template` をスターターテンプレートとして作成
7. `docs/customization.md` に Theme Package ワークフローを記載

### Phase 3（プラグイン需要が出た場合）:

8. React Server Components と互換性のある Plugin API を設計
9. プラグインローダーとフックシステムを実装

## 参考資料

- [shadcn/ui ドキュメント](https://ui.shadcn.com/)
- [Tailwind CSS v4 Alpha](https://tailwindcss.com/docs/v4-beta)
- [Radix UI Primitives](https://www.radix-ui.com/primitives)
- [Class Variance Authority](https://cva.style/docs)
- CKAN テーマドキュメント（コンセプト参考）

## 関連 ADR

- ADR-008: Turborepo Monorepo（packages/ui の分離）
- 将来: Plugin System の ADR（Tier 3 実装時）
