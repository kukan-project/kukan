# ADR-008: Turborepo + pnpm workspaces でモノレポ管理する

## ステータス

承認済み（2026-03-01）

## コンテキスト

KUKANは複数のアプリ（api, web, worker, editor）と共有パッケージ（db, shared, quality等）で構成される。これらを効率的に管理するモノレポツールが必要。

## 検討した選択肢

### A) Nx

- 良い点: 高度なキャッシュ、影響範囲分析、プラグインエコシステム
- 問題点: 設定が複雑、学習コストが高い、KUKANの規模には過剰

### B) Turborepo + pnpm workspaces — 採用

- 良い点:
  - ゼロ設定に近い（turbo.json + pnpm-workspace.yaml のみ）
  - タスク依存グラフの自動解決（build → test の順序保証）
  - ローカル＋リモートキャッシュ（Vercel連携またはセルフホスト）
  - pnpm の厳格な依存管理（phantom dependency 防止）
  - Vercel 公式メンテナンス（Next.js との相性が良い）
- 問題点: Nx ほどの影響範囲分析はない

### C) npm/yarn workspaces のみ（ツールなし）

- 問題点: ビルド順序を手動管理、キャッシュなし

## 決定

Turborepo + pnpm workspaces を採用する。

## 設定概要

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {},
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

## 根拠

- KUKANの規模（4 apps + 10 packages）にちょうど良い複雑さ
- pnpm の厳格なnode_modules構造でパッケージ間の依存が明確
- ビルドキャッシュでCI時間を大幅短縮
- Next.js + Vercel エコシステムとの統合が自然

## 影響

- パッケージ間依存は `@kukan/パッケージ名` で参照
- 各パッケージに `package.json` と `tsconfig.json` を配置
- ルートに `turbo.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- CIでは `pnpm turbo run build test lint typecheck` で全タスク実行
