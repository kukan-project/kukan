> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/010-shadcn-ui-theming-strategy.md`](../jp/010-shadcn-ui-theming-strategy.md).

# ADR-010: shadcn/ui Theming Strategy

## Status

Accepted (2026-03-03)

## Context

KUKAN is a data catalog platform for Japanese municipalities, each with different branding requirements (colors, logos, layout). A theming strategy is needed that balances the following:

1. **Ease of customization**: Municipalities can apply branding without deep technical knowledge
2. **Maintainability**: Core updates and customizations are decoupled
3. **Type safety**: TypeScript benefits are preserved during customization
4. **Progressive enhancement**: Simple customizations require no build step, while advanced customizations are also supported

CKAN's template hierarchy (default → extension → custom) is a useful reference, but KUKAN's modern architecture (API separation, React, TypeScript) requires a different approach.

## Options Considered

### A) Material-UI (MUI)

- Pros: Large ecosystem, rich component library, complete theming system
- Cons:
  - Heavy dependencies (increased bundle size)
  - Complex style customization (CSS-in-JS, sx prop)
  - Constraints with Next.js App Router integration
  - Components are black boxes (difficult to modify internal implementation)

### B) Ant Design

- Pros: Rich admin-oriented components, theme variable system
- Cons:
  - Chinese-oriented design (adjustments needed for Japanese municipalities)
  - Unstable during migration from Less to CSS-in-JS
  - Immature React Server Components support
  - Low customization flexibility

### C) Chakra UI

- Pros: Component-level customizability, CSS Variables support
- Cons:
  - Architecture overhaul in v3 (stability concerns)
  - Somewhat large bundle size
  - Not recommended for use alongside Tailwind

### D) shadcn/ui + Tailwind CSS 4 — Adopted

- Pros:
  - **Copy-and-paste approach**: Components are placed directly in the project, giving full ownership
  - **Radix UI-based**: Accessibility (WCAG compliance) built in
  - **Tailwind CSS integration**: Flexible utility-first styling
  - **CSS Variables**: Easy runtime theme switching
  - **Type safety**: Full TypeScript benefits
  - **React Server Components support**: Fully compatible with Next.js 16 App Router
  - **Lightweight**: Only the needed components are included, minimal dependencies
- Cons:
  - Manual updates: shadcn/ui updates are not automatically applied (since they are copied)
  - Tailwind dependency: Cannot be used in projects that don't use Tailwind
  - Learning curve: Requires understanding of Tailwind CSS

## Decision

Adopt **shadcn/ui** as the UI component foundation and implement a **3-tier theming strategy**.

## Rationale

### Technology Stack

1. **shadcn/ui** - Component collection
   - Copy-and-paste approach (not a library)
   - Radix UI (accessibility) + Tailwind CSS (styling) + CVA (variant management)
   - Full ownership and customization freedom

2. **Tailwind CSS 4** - Utility-first CSS framework
   - CSS-first configuration (`@theme` directive)
   - Native CSS Variables support
   - Rust-based engine for improved performance

3. **CSS Variables** - Build-free runtime theme switching
   - HSL color format (easy to manipulate)
   - shadcn/ui convention: `--primary`, `--secondary`, etc.
   - KUKAN-specific variables: `--kukan-` prefix

### 3-Tier Theming Strategy

```
┌─────────────────────────────────────────┐
│ Tier 1: CSS Variables (runtime)        │ ← 80% of use cases
│  - Colors, spacing, typography         │
│  - No build required                   │
│  - Injection via environment variables │
├─────────────────────────────────────────┤
│ Tier 2: Theme Package (build-time)     │ ← 15% of use cases
│  - Component-level overrides           │
│  - Layout customization                │
│  - Fork apps/web → apps/web-custom-*   │
├─────────────────────────────────────────┤
│ Tier 3: Plugin System (future)         │ ← 5% of use cases
│  - Custom pages and features           │
│  - To be considered in Phase 3+        │
└─────────────────────────────────────────┘
```

#### Tier 1: CSS Variables (Phase 1)

> **Note: The customization mechanism has been refined in ADR-023.**
> Instead of injecting external CSS via the `CUSTOM_THEME_URL` environment variable, the adopted approach is to write CSS variables directly in `apps/web/src/brand/theme.css` on the fork side. The content below is retained as the original design discussion.

**Implementation:**

```css
/* apps/web/app/globals.css */
@layer base {
  :root {
    /* shadcn/ui default variables */
    --background: 0 0% 100%;
    --foreground: 222.2 47.4% 11.2%;
    --primary: 221.2 83.2% 53.3%; /* KUKAN Blue */
    --secondary: 210 40% 96.1%;
    --radius: 0.5rem;

    /* KUKAN-specific variables (add as needed) */
    --kukan-header-height: 4rem;
    --kukan-logo-height: 2.5rem;
    --kukan-container-max-width: 1280px;
  }
}
```

**Customization method:**

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

Municipalities provide a CSS file:

```css
/* https://tokyo.example.jp/kukan-theme.css */
:root {
  --primary: 0 72% 51%; /* Tokyo red */
  --kukan-header-height: 5rem;
}
```

**Benefits:**

- No build required
- Simple deployment (just host a CSS file)
- Covers most branding requirements (colors, spacing, typography)

**Constraints:**

- Cannot change component structure or layout

#### Tier 2: Theme Package (Phase 2+)

> **Note: This section has been superseded by ADR-023 (Brand Override Layer).**
> The Tier 2 implementation approach adopts an override pattern using `apps/web/src/brand/` directory instead of `apps/web-custom-*`. The content below is retained as the original design discussion.

For municipalities requiring deeper customization:

```
apps/web-custom-tokyo/
├── components/
│   ├── Header.tsx           # Override specific components
│   └── Footer.tsx
├── app/
│   └── layout.tsx           # Custom layout
├── tailwind.config.ts       # Custom theme configuration
└── package.json
    {
      "dependencies": {
        "@kukan/web-core": "^1.0.0",  # Future: package apps/web
        "@kukan/ui": "workspace:*"
      }
    }
```

**Override pattern:**

```typescript
// apps/web-custom-tokyo/components/Header.tsx
import { Header as DefaultHeader } from '@kukan/web-core/components/Header'

export function Header() {
  return (
    <DefaultHeader
      logoSrc="/tokyo-logo.svg"
      primaryColor="red"
    >
      <CustomNav /> {/* Add custom elements */}
    </DefaultHeader>
  )
}
```

**Benefits:**

- TypeScript type safety is preserved
- Partial overrides (change only what's needed)
- Component-level customization

**Trade-offs:**

- Build step required
- Municipalities need basic Node.js knowledge

#### Tier 3: Plugin System (Phase 3+, optional)

For advanced use cases (custom features, third-party integrations):

```typescript
// Concept API (not implemented in Phase 1)
const plugins = await loadPlugins(process.env.KUKAN_PLUGINS?.split(','))

export default function RootLayout({ children }) {
  return (
    <PluginProvider plugins={plugins}>
      {children}
    </PluginProvider>
  )
}
```

**Conditions for deferring implementation:**

- Until custom feature requests come from multiple municipalities
- Until clear patterns of extensibility needs emerge

### Variable Naming Conventions

**shadcn/ui variables** (used as-is):

- `--background`, `--foreground`
- `--primary`, `--secondary`, `--muted`, `--accent`
- `--border`, `--input`, `--ring`
- `--radius`

**KUKAN-specific variables** (add only when needed):

- Prefix: `--kukan-`
- Examples: `--kukan-header-height`, `--kukan-logo-height`
- Principle: **YAGNI** (You Ain't Gonna Need It) - add only when actually needed

**Things to avoid:**

- No over-engineering: pre-defining 100+ variables
- No duplicate management: maintaining both Tailwind config and CSS Variables
- No unused variables: creating variables "just in case"

### Documentation Requirements

Create `docs/customization.md` covering:

1. Available CSS variables and their effects
2. Sample theme CSS files
3. Tier 2 Theme Package guide (when implemented)
4. Migration guide between tiers

## Consequences

### Benefits

1. **Progressive customization path**: Progress from simple (CSS) to advanced (Theme Package)
2. **No vendor lock-in**: Components are in the project with full customizability
3. **Type safety**: TypeScript intellisense works during customization
4. **Built-in accessibility**: WCAG compliance via Radix UI
5. **Modern stack**: React Server Components and Next.js 16 compatible
6. **Storybook integration**: Easy component catalog for municipalities

### Drawbacks

1. **Learning curve**: Tailwind CSS knowledge required for Tier 2+
2. **Manual updates**: shadcn/ui updates require manual re-copying
3. **Build complexity**: Tier 2 customization requires Node.js toolchain

### Neutral

1. **Tailwind dependency**: The entire theming system depends on Tailwind CSS (acceptable as a project requirement)
2. **CSS Variables format**: HSL format may be unfamiliar (well documented in shadcn/ui)

## Implementation Plan

### Phase 1 (current):

1. Set up `packages/ui` with shadcn/ui

   ```bash
   cd packages/ui
   npx shadcn@latest init
   npx shadcn@latest add button card badge dialog input table
   ```

2. Define CSS Variables in `apps/web/app/globals.css`
   - shadcn/ui defaults
   - Minimal KUKAN-specific variables (5-10)

3. Create KUKAN catalog components in `packages/ui/src/components/catalog/`
   - DatasetCard, ResourceList, OrganizationBadge, etc.

4. Document components with Storybook

### Phase 2 (when first customization demand arises):

5. Extract `apps/web` as `@kukan/web-core` package
6. Create `apps/web-custom-template` as a starter template
7. Add Theme Package workflow to `docs/customization.md`

### Phase 3 (if plugin demand arises):

8. Design a Plugin API compatible with React Server Components
9. Implement plugin loader and hook system

## References

- [shadcn/ui Documentation](https://ui.shadcn.com/)
- [Tailwind CSS v4 Alpha](https://tailwindcss.com/docs/v4-beta)
- [Radix UI Primitives](https://www.radix-ui.com/primitives)
- [Class Variance Authority](https://cva.style/docs)
- CKAN theming documentation (concept reference)

## Related ADRs

- ADR-008: Turborepo Monorepo (packages/ui separation)
- ADR-023: Brand Override Layer (refines and supersedes Tier 2)
- Future: Plugin System ADR (when Tier 3 is implemented)
