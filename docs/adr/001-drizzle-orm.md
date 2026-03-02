# ADR-001: Drizzle ORM を採用する

## ステータス
承認済み（2026-03-01）

## コンテキスト
データカタログのORMを選定する必要がある。
CKANは SQLAlchemy（Python）を使用しているが、TypeScript統一のため新たに選定する。
Aurora Serverless v2 (Data API) への対応も考慮が必要。

## 検討した選択肢

### A) Prisma
- 良い点: 大規模コミュニティ、スキーマファーストの開発体験、マイグレーションツール充実
- 問題点:
  - 独自バイナリエンジン（Rust製）が必要 → Docker/Lambda のイメージサイズ増
  - 独自スキーマ言語（.prisma）→ TypeScriptとの二重管理
  - Aurora Data API のネイティブサポートが限定的
  - 複雑なクエリで生SQL に頼る場面が多い

### B) Kysely
- 良い点: 型安全なクエリビルダー、軽量、Aurora Data API対応
- 問題点:
  - マイグレーションツールが別途必要
  - スキーマ定義とクエリ型の二重管理
  - 日本語情報が少ない

### C) Drizzle ORM — 採用
- 良い点:
  - TypeScriptでスキーマ定義 → 型推論が完全自動
  - SQL-like API（SQLを知っていれば直感的）
  - Aurora Data API ドライバ対応（drizzle-orm/aws-data-api/pg）
  - 軽量（バイナリ不要）
  - Drizzle Kit でマイグレーション管理
  - Better Auth が Drizzle ネイティブ統合を提供
- 問題点:
  - Prisma ほどのエコシステム規模ではない
  - 一部のエッジケースでAPIが安定していない可能性

## 決定
Drizzle ORM を採用する。

## 根拠
- TypeScript統一方針との親和性（スキーマもTSで書ける）
- Aurora Data API 対応がネイティブ（AWS環境で重要）
- Better Auth との統合が自然（同じDB接続を共有）
- バイナリ依存なしで軽量（Docker/Lambda に有利）
- SQL-like APIで学習コスト低（CKANのSQLAlchemyユーザーにも馴染みやすい）

## 影響
- `packages/db` でDrizzleスキーマを一元管理
- Better Auth のテーブル定義もDrizzleスキーマに統合
- マイグレーションは Drizzle Kit（`drizzle-kit generate` / `drizzle-kit migrate`）
