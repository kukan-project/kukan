# ADR-011: 統一バリデーションシステム（Zod + FormRequest 風）

## ステータス

**提案中（Proposed）** — 実装は Phase 2 以降で検討

## コンテキスト

現在の KUKAN のバリデーションは以下のように実装されている：

1. **Zod スキーマ定義**（`packages/shared/src/validators/`）
   - 入力の型チェックとフォーマット検証
   - エラーメッセージはスキーマに直接埋め込み

2. **Service レイヤーでの追加検証**
   - 名前の一意性チェック
   - 外部キー制約の検証（Organization の存在確認など）
   - トランザクション内で実行

3. **Hono ルーターでの統合**
   - `@hono/zod-validator` で入力検証
   - バリデーションエラーは RFC 7807 形式で返却

### 課題

1. **エラーメッセージの管理**
   - 英語メッセージがスキーマ定義に直接埋め込まれている
   - 多言語対応（日本語など）が困難
   - メッセージの一元管理ができない

2. **フロントエンド・バックエンドでの重複**
   - バリデーションルールを両方で実装する必要
   - 同期が取れなくなるリスク

3. **バリデーション層の責務が不明確**
   - 型チェック（Zod）とビジネスルール（Service）の境界が曖昧
   - 認可チェックの場所が統一されていない

4. **Laravel などの既存フレームワークとの差**
   - Laravel の `FormRequest` のような統一的なバリデーション管理機構がない
   - 段階的バリデーション（形式 → 認可 → ビジネスルール）の仕組みがない

## 検討した選択肢

### A) 現状維持（Zod + Service レイヤー）

**メリット:**

- シンプル
- Zod の標準的な使い方
- 学習コストが低い

**デメリット:**

- 多言語対応が困難
- フロントエンド・バックエンドでの重複
- バリデーション層の責務が不明確

### B) class-validator（NestJS スタイル）

**メリット:**

- デコレーターベースで直感的
- NestJS との親和性が高い

**デメリット:**

- Zod の型推論の恩恵を失う
- React Server Components との相性が悪い
- すでに Zod を採用済み（移行コスト大）

### C) Laravel FormRequest 風の統一バリデーションシステム（提案）

**メリット:**

- バリデーションルールを一元管理
- 多言語対応が容易
- フロントエンド・バックエンドで同じコードを使用
- 段階的バリデーション（形式 → 認可 → ビジネスルール）
- Zod の型安全性を維持

**デメリット:**

- 追加の抽象化レイヤーが必要
- 学習コストがやや増加
- Phase 1 での実装は時期尚早

## 提案内容

Laravel の `FormRequest` に着想を得た統一バリデーションシステムを構築する。

### アーキテクチャ

```
packages/shared/src/validation/
├── rules.ts              # 共通バリデーションルール定義
├── messages.ts           # エラーメッセージ（多言語対応）
├── requests/             # FormRequest 風のバリデータークラス
│   ├── BaseRequest.ts
│   ├── CreatePackageRequest.ts
│   ├── UpdateOrganizationRequest.ts
│   └── ...
└── index.ts
```

### 1. 共通ルール定義

```typescript
// packages/shared/src/validation/rules.ts
import { z } from 'zod'

export const Rules = {
  string: {
    required: () => z.string().min(1),
    optional: () => z.string().optional(),
    url: () => z.string().url(),
    email: () => z.string().email(),
    uuid: () => z.string().uuid(),
  },

  name: {
    dataset: () =>
      z
        .string()
        .min(2)
        .max(100)
        .regex(/^[a-z0-9-_]+$/),
    tag: () => z.string().min(1).max(200),
  },

  number: {
    pagination: {
      offset: () => z.coerce.number().min(0).default(0),
      limit: () => z.coerce.number().min(1).max(100).default(20),
    },
  },
}
```

### 2. エラーメッセージ管理

```typescript
// packages/shared/src/validation/messages.ts
export type Locale = 'en' | 'ja'

export const ValidationMessages = {
  en: {
    required: 'This field is required',
    invalid_email: 'Invalid email address',
    name_format: 'Name must contain only lowercase letters, numbers, hyphens, and underscores',
    name_exists: 'Name already exists',
  },
  ja: {
    required: 'この項目は必須です',
    invalid_email: 'メールアドレスの形式が正しくありません',
    name_format: '名前は小文字英数字、ハイフン、アンダースコアのみ使用できます',
    name_exists: 'この名前は既に使用されています',
  },
}

export function createZodErrorMap(locale: Locale = 'en') {
  // Zod のカスタムエラーマップを生成
}
```

### 3. FormRequest 風のバリデータークラス

```typescript
// packages/shared/src/validation/requests/BaseRequest.ts
export abstract class BaseRequest<T extends z.ZodType> {
  protected schema: T
  protected locale: Locale

  safeParse(data: unknown): z.SafeParseReturnType<z.input<T>, z.infer<T>> {
    return this.schema.safeParse(data, {
      errorMap: createZodErrorMap(this.locale),
    })
  }

  // ビジネスルールバリデーション（サブクラスでオーバーライド）
  async authorize?(data: z.infer<T>, context?: unknown): Promise<boolean>

  // カスタムバリデーション（DB固有など）
  async withValidator?(data: z.infer<T>): Promise<Record<string, string> | null>
}
```

```typescript
// packages/shared/src/validation/requests/CreatePackageRequest.ts
export class CreatePackageRequest extends BaseRequest<typeof createPackageSchema> {
  async authorize(data, context) {
    // 認証済みユーザーのみ作成可能
    return !!context?.userId
  }

  async withValidator(data) {
    // 名前の一意性チェックなど
    // 実際はDBアクセスが必要
  }
}
```

### 4. バックエンド（Hono）での利用

```typescript
// apps/api/src/routes/packages.ts
import { CreatePackageRequest } from '@kukan/shared'

function validateRequest<T>(RequestClass: new (locale: Locale) => BaseRequest<T>) {
  return async (c, next) => {
    const locale = c.req.header('Accept-Language')?.startsWith('ja') ? 'ja' : 'en'
    const validator = new RequestClass(locale)

    // 1. 形式バリデーション
    const result = validator.safeParse(await c.req.json())
    if (!result.success) {
      /* エラーレスポンス */
    }

    // 2. 認可チェック
    if (validator.authorize) {
      const authorized = await validator.authorize(result.data, { userId: c.get('user')?.id })
      if (!authorized) {
        /* 403 レスポンス */
      }
    }

    // 3. カスタムバリデーション
    if (validator.withValidator) {
      const errors = await validator.withValidator(result.data)
      if (errors) {
        /* 422 レスポンス */
      }
    }

    c.set('validated', result.data)
    await next()
  }
}

packagesRouter.post('/', validateRequest(CreatePackageRequest), async (c) => {
  const input = c.get('validated')
  // ...
})
```

### 5. フロントエンド（Next.js）での利用

```typescript
// apps/web/app/packages/create/page.tsx
'use client'

import { CreatePackageRequest } from '@kukan/shared'
import { useLocale } from 'next-intl'

export default function CreatePackagePage() {
  const locale = useLocale() as 'en' | 'ja'

  const handleSubmit = async (formData) => {
    // クライアント側で事前バリデーション（多言語対応）
    const validator = new CreatePackageRequest(locale)
    const result = validator.safeParse(data)

    if (!result.success) {
      setErrors(result.error.flatten().fieldErrors)
      return
    }

    // サーバーに送信
    await fetch('/api/v1/packages', {
      /* ... */
    })
  }
}
```

## メリット

1. **一元管理**
   - バリデーションルールを `packages/shared` で管理
   - フロントエンド・バックエンドで同じコードを使用
   - DRY原則の徹底

2. **多言語対応**
   - エラーメッセージを `ValidationMessages` で管理
   - ロケールに応じて自動切り替え
   - 翻訳の一元管理

3. **型安全性**
   - Zod の型推論をフル活用
   - TypeScript の恩恵を完全に享受
   - コンパイル時にエラー検出

4. **段階的バリデーション**
   - **形式チェック**: Zod による型・フォーマット検証
   - **認可チェック**: `authorize()` メソッドで権限確認
   - **ビジネスルール**: `withValidator()` でDB固有検証
   - 責務の明確化

5. **Laravel との親和性**
   - Laravel 経験者が理解しやすい
   - 既存のメンタルモデルを活用

6. **テスト容易性**
   - バリデーションロジックを独立してテスト可能
   - モック化が容易

## デメリット

1. **追加の抽象化レイヤー**
   - 学習コストがやや増加
   - シンプルなケースでは冗長
   - 初期実装の手間

2. **DB依存のバリデーション**
   - `withValidator` でDBアクセスが必要
   - Service層との責務の切り分けが課題
   - パフォーマンスへの影響

3. **Zod の制約**
   - Laravel の `Rule` クラスほど柔軟ではない
   - 複雑なバリデーションは実装が難しい

4. **フロントエンドのバンドルサイズ**
   - バリデーションクラスがクライアントに含まれる
   - Tree-shaking の工夫が必要

## 実装計画

### Phase 1（現在）

- **実装しない**（時期尚早）
- 既存の `validators/` を継続使用
- 後方互換性を保つ

### Phase 2（初回カスタマイズ需要発生時）

1. `packages/shared/src/validation/` ディレクトリを作成
2. `Rules` と `ValidationMessages` を実装
3. `BaseRequest` クラスを実装
4. 1〜2個の FormRequest クラスを試験実装（CreatePackageRequest など）
5. フロントエンド（apps/web）で利用開始
6. フィードバックを収集

### Phase 3（本格展開）

7. 既存の `validators/` を FormRequest 風に移行
8. 多言語対応を本格化（日本語メッセージ追加）
9. Hono ミドルウェアを共通化
10. ドキュメント整備（`docs/validation.md`）

### Phase 4（完全移行）

11. `validators/` を deprecated に
12. 全エンドポイントで FormRequest を使用
13. パフォーマンス最適化（キャッシュなど）

## 代替案・参考実装

- [tRPC](https://trpc.io/) - TypeScript エンドツーエンド型安全
- [Remix](https://remix.run/docs/en/main/guides/data-writes) - アクションバリデーション
- [Nuxt/Laravel](https://github.com/laravel/framework/blob/11.x/src/Illuminate/Foundation/Http/FormRequest.php) - FormRequest 実装

## 関連 ADR

- ADR-001: Drizzle ORM（DB固有バリデーションとの連携）
- ADR-010: shadcn/ui テーマ戦略（フロントエンドフォームとの統合）

## 決定の延期理由

1. **Phase 1 では過剰設計**
   - 現時点では Organization と Package のみ実装
   - 多言語対応の需要が明確でない
   - フロントエンドが未実装

2. **実装の優先度**
   - Phase 1 は API の基本機能実装を優先
   - バリデーション改善は Phase 2 以降

3. **実際の需要を見極める**
   - 自治体からの多言語対応要望
   - フロントエンド実装での課題
   - パフォーマンスへの影響

**再検討タイミング:**

- Phase 2 で apps/web 実装開始時
- 多言語対応の需要が明確になった時
- バリデーションエラーのユーザビリティ改善が必要になった時

## 参考資料

- [Zod Documentation](https://zod.dev/)
- [Laravel FormRequest](https://laravel.com/docs/11.x/validation#form-request-validation)
- [Zod i18n](https://github.com/aiji42/zod-i18n)
- [Hono Validation](https://hono.dev/docs/guides/validation)
