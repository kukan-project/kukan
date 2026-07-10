> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/023-brand-override-layer.md`](../jp/023-brand-override-layer.md).

# ADR-023: Brand Override Layer

## Status

Accepted (2026-05-16, testing strategy added 2026-07-10)

## Context

KUKAN is designed for adoption by multiple organizations and municipalities, and forking the main repository for design customization is expected. ADR-010's 3-tier theme strategy is valid as a policy, but **specific measures for avoiding merge conflicts in fork operations** were undefined.

### Issues

1. **Merge conflicts**: When fork-side modifies `globals.css`, `layout.tsx`, `header.tsx`, etc. directly, conflicts occur every time upstream updates are pulled in
2. **Tier 2 ambiguity**: ADR-010's Tier 2 envisioned creating separate apps as `apps/web-custom-*`, but this required `@kukan/web-core` packageization with high implementation cost
3. **Scattered changes**: Logo, color, text, and component structure changes are spread across multiple files, making it unclear "what was changed"

### Requirements

- **Consolidate fork-side changes into a single directory**, prohibiting direct modifications to main repository files in principle
- Cover everything from CSS variables (Tier 1) to component replacement (Tier 2) with the same mechanism
- Structure where component additions/modifications on the main side do not cascade to the fork side
- Maintain type safety (overridable slots are explicit)

## Decision

Create the `apps/web/src/brand/` directory as a **brand override layer**, confining all municipal customizations to this directory.

## Rationale

### Directory Structure

```
apps/web/
├── public/
│   └── brand/              ← Static files (logo, favicon, OG image)
│       ├── logo.svg
│       ├── favicon.ico
│       └── og-image.png
└── src/
    ├── types/
    │   └── brand.ts        ← Type definitions (maintained by main, fork does not modify)
    ├── app/(brand)/[...slug]/
    │   └── page.tsx        ← Catch-all route for static pages (main side)
    └── brand/
        ├── index.ts        ← Barrel export
        ├── theme.css       ← Tier 1: CSS variable overrides
        ├── brand-config.ts ← Text, metadata, navigation items, etc.
        ├── messages/       ← i18n message overrides
        │   ├── ja.json    ← Japanese (override keys only)
        │   └── en.json    ← English (override keys only)
        ├── pages/          ← Static pages (terms of use, etc.)
        │   ├── index.ts   ← Page registration map
        │   └── terms.tsx   (sample, delete if unnecessary)
        └── overrides/      ← Tier 2: Component overrides
            ├── index.ts    ← Override registration
            ├── header.tsx   (example)
            └── footer.tsx   (example)
```

### brand-config.ts

Manages site-wide text and metadata in a single location. Main repository components reference these configuration values.

```typescript
import type { BrandConfig } from '@/types/brand'

export const brandConfig: BrandConfig = {
  // Basic site information
  siteName: 'KUKAN',
  siteDescription: 'Knowledge Unified Katalog And Network',
  copyright: 'KUKAN Contributors. AGPL-3.0 License.',
  copyrightUrl: 'https://github.com/kukan-project/kukan',

  // Logo
  logo: { type: 'default' },

  // Navigation (additional items)
  headerNavExtra: [],
  footerLinks: [{ label: 'Terms of Use', href: '/terms' }],

  // Metadata
  ogImage: '/og-default.png',
  faviconPath: '/favicon.ico',
}
```

### src/types/brand.ts (defined and maintained by main)

```typescript
import type { ComponentType } from 'react'

/** Brand configuration type definitions */
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

/** Component override slot definitions */
export interface BrandOverrides {
  Header?: ComponentType
  Footer?: ComponentType
  TopPage?: ComponentType
  // Add as needed (adding types does not break existing forks)
}
```

### overrides/index.ts

Main default:

```typescript
import type { BrandOverrides } from '@/types/brand'

export const overrides: BrandOverrides = {}
```

Fork-side example:

```typescript
import type { BrandOverrides } from '@/types/brand'
import { Header } from './header'
import { Footer } from './footer'

export const overrides: BrandOverrides = {
  Header,
  Footer,
}
```

### Consumption Pattern in Main Components

Override checking is embedded within the component itself. No separate slot file is created.

```typescript
// apps/web/src/components/layout/header.tsx (main side)
import { overrides } from '@/brand'

export async function Header() {
  const Custom = overrides.Header
  if (Custom) return <Custom />
  return <DefaultHeader />
}

export async function DefaultHeader() {
  // ...default implementation
}
```

```typescript
// apps/web/src/app/page.tsx (main side)
import { overrides } from '@/brand'

export default async function HomePage() {
  const Custom = overrides.TopPage
  if (Custom) return <Custom />
  // ...default implementation
}
```

```typescript
// apps/web/src/app/layout.tsx (main side)
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

Fork-side custom components can reuse `DefaultHeader` / `DefaultFooter` as building blocks.
Use `Default*` instead of `Header` / `Footer` to avoid circular references.

### theme.css

Main default (empty, or re-declares KUKAN default values):

```css
/* Brand theme overrides */
/* Fork-side writes CSS variables here */
```

Fork-side example:

```css
:root {
  --primary: 142 64% 32%; /* Organization brand color */
  --primary-foreground: 0 0% 100%;
  --kukan-header-height: 72px;
}
```

### i18n Message Overrides

Specify only the keys to override in `brand/messages/{locale}.json`. `src/i18n/request.ts` deep-merges brand-side messages over the default messages (`messages/{locale}.json`). When the brand-side file is an empty object `{}`, the merge is skipped and behavior is identical to the default.

Main default:

```json
{}
```

Fork-side example (`brand/messages/ja.json`):

```json
{
  "home": {
    "title": "XX City Open Data Catalog",
    "description": "A portal to search and utilize XX City's open data"
  }
}
```

- Only specified keys are overridden; unspecified keys retain their defaults
- Nested objects are merged recursively (sibling keys are preserved)
- Distinction between `brandConfig` and i18n messages: use `brandConfig` for language-independent values (metadata, OGP, etc.) and i18n messages for UI display text

### Conflict Avoidance Mechanism

| File                           | Main-side change frequency       | Fork-side changes | Conflict Risk                                 |
| ------------------------------ | -------------------------------- | ----------------- | --------------------------------------------- |
| `types/brand.ts`               | Low (only when adding slots)     | Does not modify   | None (type additions are backward-compatible) |
| `brand/brand-config.ts`        | Does not change (defaults fixed) | **Modifies**      | **Very low** (main doesn't touch)             |
| `brand/theme.css`              | Does not change                  | **Modifies**      | **Very low**                                  |
| `brand/overrides/index.ts`     | Does not change (empty object)   | **Modifies**      | **Very low**                                  |
| `brand/overrides/*.tsx`        | Does not exist                   | **Newly added**   | **None**                                      |
| `brand/messages/*.json`        | Does not change (empty object)   | **Modifies**      | **Very low**                                  |
| `brand/pages/index.ts`         | Sample only                      | **Modifies**      | **Very low**                                  |
| `brand/pages/*.tsx`            | Sample only                      | **Adds/removes**  | **Very low**                                  |
| `public/brand/*`               | Defaults only                    | **Replaces**      | **Very low**                                  |
| `app/page.tsx`                 | Normal development               | Does not modify   | None                                          |
| `components/layout/header.tsx` | Normal development               | Does not modify   | None                                          |
| `app/globals.css`              | Normal development               | Does not modify   | None                                          |

### Reusing Main Components from Override Components

Fork-side custom components can import and reuse main repository's default components and parts. Partial modification is possible instead of full replacement.

```typescript
// brand/overrides/header.tsx (fork side)
import { getCurrentUser } from '@/lib/server-api'
import { LanguageSwitcher } from '@/components/layout/language-switcher'
import { MobileNav } from '@/components/layout/mobile-nav'
import { UserMenu } from '@/components/auth/user-menu'

export async function Header() {
  const user = await getCurrentUser()

  return (
    <header className="sticky top-0 z-40 bg-[hsl(var(--primary))]">
      <div className="mx-auto flex h-[var(--kukan-header-height)] max-w-[var(--kukan-container-max-width)] items-center justify-between px-4">
        <img src="/brand/logo.svg" alt="Open Data Catalog" className="h-8" />
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

### Relationship with ADR-010

This ADR **concretizes and supersedes** ADR-010's Tier 1 and Tier 2.

| ADR-010 (old)                                         | ADR-023 (new)                                  |
| ----------------------------------------------------- | ---------------------------------------------- |
| Tier 1: External CSS injection via `CUSTOM_THEME_URL` | Fork-side writes directly in `brand/theme.css` |
| Tier 2: Separate apps as `apps/web-custom-*`          | Same-app override via `src/brand/` directory   |
| Required `@kukan/web-core` packageization             | No packageization needed, immediately usable   |
| Unclear relationship with forks                       | Designed with fork operations in mind          |

Tier 3 (plugin system) maintains ADR-010's policy as-is.

## Fork Operation Rules

1. **Fork-side changes are limited to `src/brand/`** (in principle)
2. **When changes outside `src/brand/` are necessary**, submit a PR to the main repository to "add a customization point"
3. **Main side does not modify default value files in `src/brand/`** (adding types to `src/types/brand.ts` is permitted)
4. **When a new override slot is needed**, add a key to `BrandOverrides` type in the main repository and incorporate the override check in the corresponding component
5. **Fork side regularly rebases/merges the main branch** (since `src/brand/` is isolated, conflicts should not occur in principle)
6. **Fork side does not modify main-repo test files** (the "Testing Strategy" below keeps main tests brand-independent, so no changes should be needed. If a fork customization breaks a main test, report it as a main-side bug via issue / PR)

## Testing Strategy

When a fork customizes the brand, main-repo unit tests that render slot components (`Header` / `Footer` / `HomePage`) end up rendering the custom implementation, breaking expectations against the KUKAN default text and structure. To prevent this, **main-repo tests are brand-independent (pinned to KUKAN defaults)**.

1. **Main tests must not import the real `@/brand`**. Tests that render brand-consuming components mock it and pin it to the KUKAN defaults:

   ```typescript
   vi.mock('@/brand', () => import('@/__tests__/brand-defaults'))
   ```

2. **`src/__tests__/brand-defaults.ts` is maintained by the main repo**. It is an intentional copy of the KUKAN defaults and does not import from `src/brand/brand-config.ts` (which forks rewrite). When a required field is added to `BrandConfig`, the main side updates this file as well.
3. **The slot mechanism itself is tested by the main repo** (`brand-slots.test.tsx`). With dummy overrides registered, it verifies only that "the custom component takes precedence" and does not depend on any fork's implementation.
4. **Tests for fork-specific components live in `src/brand/__tests__/`**. They are auto-discovered by the vitest include pattern (`src/**/__tests__/**/*.test.{ts,tsx}`), so no config change is needed. Whether and what to test is at the fork's discretion.
5. **i18n is already brand-independent**. The test `setup.ts` reads the default `messages/en.json` directly, so overrides in `brand/messages/` do not affect tests.

## Type Change Policy

Type definitions (`src/types/brand.ts`) are maintained by the main side. To avoid breaking fork-side `brand-config.ts` / `overrides/index.ts`, the following rules apply.

### Non-breaking changes (can be done in normal releases)

- Adding optional slots to `BrandOverrides` — fork's `{}` will not cause type errors
- Adding optional fields to `BrandConfig` — fork side does not need to specify them

```typescript
// New fields are always added as optional
export interface BrandConfig {
  // ...existing fields
  showBreadcrumb?: boolean // ← new
}

// Consumer side applies default value via ??
const show = brandConfig.showBreadcrumb ?? true
```

### Breaking changes (explicitly noted in CHANGELOG / migration guide)

- Adding required fields to `BrandConfig` — causes type errors in fork's `brand-config.ts`
- Changing existing field types, renaming, or removing fields

When breaking changes are necessary, release notes include instructions for fork-side actions.

## Implementation Plan

### Step 1 (immediate, main side)

1. Create `apps/web/src/brand/` directory and initialize with default values
2. Place type definitions in `src/types/brand.ts` (maintained by main, separate from `brand/`)
3. Modify `layout.tsx` to reference `brandConfig`
4. Convert Header / Footer to slots (`HeaderSlot`, `FooterSlot`)

### Step 2 (when forking begins)

5. Fork side edits `brand-config.ts` for the organization
6. Define color palette in `brand/theme.css`
7. Add custom components to `overrides/` as needed

### Step 3 (future, multi-municipality deployment)

8. Consider a `brand/` template generator (scaffolding CLI)
9. Expand override slots (search page, dashboard, etc.). TopPage slot is implemented in Step 1

## Consequences

### Advantages

1. **Zero conflicts**: Fork-side changes are confined to `src/brand/`, so no conflicts occur when pulling upstream updates
2. **Type safety**: `BrandOverrides` and `BrandConfig` type definitions provide IDE autocompletion for available customization points
3. **Gradual customization**: CSS variables only (5 min) → text changes (30 min) → component replacement (several hours) — progressive approach
4. **Zero impact on main development**: The slot pattern means default behavior is the existing component itself
5. **Transparency**: `git diff` shows fork-specific changes concentrated in `src/brand/` only, making reviews easy

### Disadvantages

1. **Increased indirection**: Header → overrides → Header adds 1 layer
2. **Effort to add slots**: Each new customization point requires work on the main side
3. **Full customization constraints**: Fundamentally changing page structure is difficult with this mechanism (consider a separate app in that case)

### Neutral

1. **`src/brand/` is Git-tracked**: Not `.gitignore`d (correctly tracked as fork-specific diff)
2. **Default values are committed**: KUKAN's default `brand-config.ts` exists in the main repository (not empty)

## References

- ADR-010: shadcn/ui theme strategy (Tier 2 concretized by this ADR)
- WordPress child theme pattern (reference for the override concept)
- Next.js App Router layout system

## Related ADRs

- ADR-010: shadcn/ui theme strategy (Tier 2 superseded by this ADR)
- ADR-008: Turborepo monorepo
