# ADR-011: 統一バリデーションシステム（Zod + FormRequest 風）

## ステータス

**却下（Rejected）** — Phase 2 実装の結果、現行構成で十分と判断

## コンテキスト

Phase 1 完了時点で、Laravel の `FormRequest` に着想を得た統一バリデーションシステム
（`BaseRequest` クラス + `Rules` オブジェクト + 多言語エラーメッセージ管理）の導入を検討した。

当時の課題認識：

1. エラーメッセージが Zod スキーマに直接埋め込まれており、多言語対応が困難
2. フロントエンド・バックエンドでバリデーションルールが重複するリスク
3. バリデーション層（型チェック / 認可 / ビジネスルール）の責務が不明確
4. Laravel の `FormRequest` のような統一的な管理機構がない

## 検討した選択肢

### A) 現状維持（Zod スキーマ + Service レイヤー）

- `@kukan/shared` の Zod スキーマをクライアント・サーバーで共有
- `@hono/zod-validator` でリクエスト検証
- Service 層でビジネスルール検証（一意性、存在確認）
- `permissions.ts` で認可チェック

### B) class-validator（NestJS スタイル）

- デコレーターベースで直感的だが、Zod の型推論を失う
- すでに Zod を採用済みで移行コスト大

### C) Laravel FormRequest 風の統一バリデーションシステム

- `BaseRequest` クラスに `authorize()` + `withValidator()` を統合
- `ValidationMessages` で多言語エラーメッセージ一元管理
- `Rules` オブジェクトで共通ルール定義

## 決定

**選択肢 A（現状維持）を採用し、選択肢 C を却下。**

## 却下理由

Phase 2 でフロントエンド（`apps/web`）を実装した結果、当初の課題の大部分が
現行構成で解消済みであることが判明した。

### 課題の解消状況

| 当初の課題                           | 現状                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| フロントエンド・バックエンドでの重複 | `@kukan/shared` の Zod スキーマを react-hook-form（zodResolver）と Hono（zValidator）の両方で共有しており、ルールの二重定義は発生していない |
| バリデーション層の責務が不明確       | zValidator（形式チェック）→ Route Handler（認可）→ Service（ビジネスルール）で明確に分離されている                                          |
| 多言語対応が困難                     | 現時点で需要なし。必要時は `zod-i18n` や Zod の `errorMap` で FormRequest 抽象化なしに対応可能                                              |

### Laravel FormRequest との比較

| 機能                   | Laravel FormRequest         | 現行の Zod 構成                        |
| ---------------------- | --------------------------- | -------------------------------------- |
| フィールド単体チェック | ルール文字列                | Zod メソッドチェーン                   |
| フィールド間整合性     | `required_if`, `same` 等    | `.refine()` / `.superRefine()`         |
| 条件付きルール         | `sometimes`, `Rule::when()` | `.refine()`, `z.discriminatedUnion()`  |
| ネスト・配列           | `'items.*.name'`            | `z.array(z.object({...}))`             |
| 型推論                 | なし                        | `z.infer<typeof schema>` で自動生成    |
| クライアント共有       | 不可（PHP）                 | **そのまま共有可能**                   |
| DB 依存チェック        | `Rule::unique()` 等         | Service 層で実装（責務分離として適切） |
| 認可                   | `authorize()`               | `permissions.ts` で実装                |
| i18n                   | `validation.php`            | `zod-i18n` / `errorMap` で対応可能     |

FormRequest 風の抽象化は、認可・DB チェック・形式チェックを1クラスに凝集させる設計だが、
KUKAN では既にそれぞれ適切なレイヤーに分離されており、統合するメリットが薄い。
むしろ追加の抽象化レイヤーは学習コストとバンドルサイズの増加を招く。

## 関連 ADR

- ADR-001: Drizzle ORM
