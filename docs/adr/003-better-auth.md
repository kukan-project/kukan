# ADR-003: Better Auth + OIDC を採用する

## ステータス

承認済み（2026-03-01）

## コンテキスト

API（Hono）とフロントエンド（Next.js）の両方で動作する認証基盤が必要。
v3設計ではAuth.jsを採用していたが、Hono APIサーバーとの統合に課題があった。
また、オンプレ閉域網ではKeycloak等の外部IdPとのOIDC連携が必須要件。

## 検討した選択肢

### A) Auth.js (NextAuth) — v3の設計

- 良い点: 大規模コミュニティ、Next.js統合が自然
- 問題点:
  - Next.js以外のランタイム対応が後付け的
  - HonoのAPIサーバーで使うにはアダプター自作が必要
  - DB連携がアダプター依存（Drizzleアダプターの安定性に不安）
  - OIDCクライアント機能がプラグイン的で設定が複雑

### B) Better Auth + OIDC — 採用

- 良い点:
  - フレームワーク非依存（Hono / Next.js / Express いずれでも動作）
  - Drizzle ORM ネイティブ統合（同じDB接続を共有）
  - OIDC クライアントプラグインでCognito / Keycloak連携
  - プラグインアーキテクチャ（2FA、組織管理、API Key等を段階的追加）
  - TypeScript ファースト
- 問題点:
  - Auth.js と比べてまだ若いプロジェクト
  - コミュニティ規模が小さい

### C) Lucia Auth

- 良い点: 軽量、教育的、セッション管理に特化
- 問題点: OIDC対応なし、プラグインエコシステムなし、メンテナンスモード

## 決定

Better Auth + OIDC プラグインを採用する。

## 根拠

- Hono APIサーバーとNext.jsフロントの両方で同一ライブラリを使える唯一の選択肢
- Drizzle ORMとの統合が最も自然（`packages/db` でスキーマ一元管理可能）
- OIDC標準準拠のため、将来IdP差し替えが容易（ベンダーロックイン回避）
- 若さのリスクはOIDC標準準拠で軽減（最悪、別ライブラリに移行しやすい）

## 影響

- `packages/db` に Better Auth テーブル定義を含める
- 認証フローは `apps/api` 内の Better Auth インスタンスが一元管理
- Next.js側は Better Auth クライアントでセッション参照
- 環境別IdP: Cognito（AWS）/ Keycloak（オンプレLGWAN）/ ローカルメール認証（開発）

## 実装ガイダンス: Better Auth + Drizzle 統合

### テーブル統合方針

Better Auth は内部的に `user`, `session`, `account`, `verification` テーブルを使用する。
KUKAN の `user` テーブルと Better Auth の `user` テーブルは **同一テーブル** として統合する。

**手順:**

1. Better Auth の `toSchema()` でベーステーブル定義を取得
2. KUKAN独自カラム（`name`, `display_name`, `sysadmin`, `state`, `extras` 等）を追加
3. `session`, `account`, `verification` は Better Auth のデフォルト定義をそのまま使用

```typescript
// packages/db/src/schema/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

// Better Auth が必要とする追加テーブル（session, account, verification）
// これらは Better Auth の公式ドキュメントに従って定義する。
// → https://www.better-auth.com/docs/adapters/drizzle
// 実装時に必ず Better Auth の最新ドキュメントを参照すること。
```

### Better Auth インスタンスの初期化

```typescript
// apps/api/src/auth/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@kukan/db'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  session: {
    // セッション有効期間等の設定
    expiresIn: 60 * 60 * 24 * 7, // 7日
  },
  // Phase 6 で追加:
  // plugins: [oidcClient({ ... })]
})
```

### API Key 認証との共存

Better Auth はセッションベース認証を担当し、API Key 認証は独自実装で共存する。
ミドルウェアで両方を順番にチェック:

1. `Authorization: Bearer <api_key>` → `api_token` テーブルで検証
2. Cookie セッション → Better Auth で検証
3. どちらもなければ 401
