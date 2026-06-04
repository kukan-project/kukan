> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/011-unified-validation-system.md`](../jp/011-unified-validation-system.md).

# ADR-011: Unified Validation System (Zod + FormRequest-style)

## Status

**Rejected** — Phase 2 implementation confirmed the current setup is sufficient

## Context

At the completion of Phase 1, we considered introducing a unified validation system inspired by Laravel's `FormRequest` (`BaseRequest` class + `Rules` object + multilingual error message management).

Issues identified at the time:

1. Error messages embedded directly in Zod schemas, making multilingual support difficult
2. Risk of duplicate validation rules between frontend and backend
3. Unclear responsibilities across validation layers (type checking / authorization / business rules)
4. Lack of a unified management mechanism like Laravel's `FormRequest`

## Options Considered

### A) Status Quo (Zod schemas + Service layer)

- Share Zod schemas from `@kukan/shared` between client and server
- Request validation with `@hono/zod-validator`
- Business rule validation in the Service layer (uniqueness, existence checks)
- Authorization checks in `permissions.ts`

### B) class-validator (NestJS style)

- Intuitive decorator-based approach, but loses Zod's type inference
- High migration cost since Zod is already adopted

### C) Laravel FormRequest-style Unified Validation System

- Integrate `authorize()` + `withValidator()` into a `BaseRequest` class
- Centralize multilingual error messages with `ValidationMessages`
- Define common rules with a `Rules` object

## Decision

**Adopt Option A (status quo) and reject Option C.**

## Rejection Rationale

After implementing the frontend (`apps/web`) in Phase 2, it became clear that most of the originally identified issues were already resolved by the current setup.

### Issue Resolution Status

| Original Issue                            | Current State                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplication between frontend and backend  | Zod schemas from `@kukan/shared` are shared by both react-hook-form (zodResolver) and Hono (zValidator), so no duplicate rule definitions occur |
| Unclear validation layer responsibilities | Clearly separated: zValidator (format checking) → Route Handler (authorization) → Service (business rules)                                      |
| Multilingual support is difficult         | No current demand. When needed, `zod-i18n` or Zod's `errorMap` can handle it without FormRequest abstraction                                    |

### Comparison with Laravel FormRequest

| Feature                 | Laravel FormRequest         | Current Zod Setup                                                 |
| ----------------------- | --------------------------- | ----------------------------------------------------------------- |
| Single field validation | Rule strings                | Zod method chaining                                               |
| Cross-field consistency | `required_if`, `same`, etc. | `.refine()` / `.superRefine()`                                    |
| Conditional rules       | `sometimes`, `Rule::when()` | `.refine()`, `z.discriminatedUnion()`                             |
| Nested / arrays         | `'items.*.name'`            | `z.array(z.object({...}))`                                        |
| Type inference          | None                        | Auto-generated via `z.infer<typeof schema>`                       |
| Client sharing          | Not possible (PHP)          | **Directly shareable**                                            |
| DB-dependent checks     | `Rule::unique()`, etc.      | Implemented in Service layer (appropriate separation of concerns) |
| Authorization           | `authorize()`               | Implemented in `permissions.ts`                                   |
| i18n                    | `validation.php`            | Can be handled with `zod-i18n` / `errorMap`                       |

The FormRequest-style abstraction consolidates authorization, DB checks, and format validation into a single class. However, in KUKAN these are already separated into appropriate layers, and consolidating them offers little benefit. Rather, an additional abstraction layer would increase learning cost and bundle size.

## Related ADRs

- ADR-001: Drizzle ORM
