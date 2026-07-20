> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/042-multi-brand-build.md`](../jp/042-multi-brand-build.md).

# ADR-042: Multi-Brand Build (Brand Selection via `KUKAN_BRAND`)

## Status

**Accepted** — Implemented. This ADR **extends** ADR-023 (brand override layer) rather than superseding it. The fork-oriented brand layer stays as is; a selection mechanism is added so a fork can hold multiple brands.

Decisions fixed at implementation time (deltas from the proposal):

- The default brand moved from `src/brand/` to **`brands/default/`**, consolidating every brand under `brands/` (symmetric). `@/brand` always resolves to `brands/<brand>` (default when unset), including the default
- The default resolves statically via **tsconfig paths** (`@/brand` → `brands/default`), so a bare OSS build / typecheck / test does not depend on the alias mechanism. Only `KUKAN_BRAND` overrides the resolution in `next.config.ts`
- No `brands/example/` scaffold. **Add a new brand by copying `brands/default/`** (default is both the real default and the reference template)
- Static assets are always copied from the active brand's `public/` into `public/brand/` (generated, gitignored); the default is `brands/default/public/`
- Existing forks must migrate (see below)

## Context

The ADR-023 brand layer assumes "1 fork = 1 brand": a fork edits the brand directory (then `apps/web/src/brand/`) directly. When a single fork operates multiple sites (ADR-041), it needs multiple brands, but with the current structure the only option is one fork per site — making upstream-tracking cost proportional to the number of sites.

All the core (OSS) repository needs to provide is **a mechanism to select among multiple brands**; the brand contents live in forks. With this division of roles, no organization-specific material (logos, organization names, custom pages) ever lands in the public repository.

## Options Considered

### A) Build-time selection — brand catalog (adopted)

The fork keeps multiple `apps/web/brands/<name>/` directories and the build argument `KUKAN_BRAND` switches what `@/brand` resolves to. One web image is built per site.

- Works without touching any ADR-023 assets (type definitions, slot mechanism, test strategy, TSX static pages)
- Only the selected brand is included in a build, so brands never mix in a bundle
- With per-site ECS services (ADR-041), "1 process = 1 brand" is sufficient; per-request brand resolution is unnecessary

### B) Startup-time selection — all brands bundled

Bundle every brand into one image and select via an environment variable at startup. Only one image is needed, but the static `import '@/brand/theme.css'`, the static `metadata` in `layout.tsx`, and the propagation of config to client components would all have to be rewritten for runtime resolution, and every brand ships in the client bundle. Under ADR-041 the "single image" benefit is small — not worth it.

### C) Runtime data-driven

Move config, theme, and copy into the database / S3 and edit them in an admin UI. No rebuilds needed, but Tier 2 (component overrides) is lost and static pages can no longer be written in TSX. We keep open a future path of gradually migrating only the data-like parts of `brandConfig` (siteName, footer links, etc.) to ADR-036 runtime settings.

## Decision

**Adopt option A. The core provides only the `KUKAN_BRAND` selection mechanism; brand contents are added by forks under `apps/web/brands/`.**

### Directory structure

```
apps/web/
└── brands/
    ├── default/        ← default brand (core-owned content + reference template)
    │   └── brand-config.ts / theme.css / messages/ / overrides/ / pages/ / public/
    ├── _shared/        ← fork operator's shared parts (optional, fork-added)
    └── <name>/         ← fork-added brand (made by copying default)
```

- `KUKAN_BRAND` unset → **`brands/default/`** (resolved statically via the tsconfig path `@/brand` → `brands/default`). A bare OSS build / typecheck / test does not depend on the alias mechanism
- `KUKAN_BRAND=<name>` → `next.config.ts` overrides `@/brand` (and each subpath) to resolve to `apps/web/brands/<name>/`
- The location is `apps/web/brands/` rather than the repository root so that Next.js compilation scope, tsconfig includes, and alias resolution such as `@/components/*` stay self-contained within the app

### Mechanism (core-side implementation)

1. **Default resolution**: tsconfig paths in `apps/web/tsconfig.json` map `@/brand` → `brands/default` and `@/brand/*` → `brands/default/*`. The vitest aliases (both the web project in the root `vitest.config.ts` and `apps/web/vitest.config.ts`) point at `brands/default` too
2. **Override when a brand is set**: `next.config.ts`, for `KUKAN_BRAND` (other than `default`), overrides `@/brand` / `@/brand/theme.css` / `@/brand/pages` / `@/brand/brand-config` / `@/brand/messages` to `brands/<name>/`. Turbopack's `resolveAlias` is exact-match, so each subpath is enumerated (project-relative values); webpack gets the same (absolute values)
3. **Static assets**: `scripts/copy-brand-assets.mjs` copies the active brand's `public/` into `public/brand/` (generated, gitignored) before dev/build. The destination is shared by all brands; unset → `brands/default/public/`. Served at `/brand/...` at runtime
4. **Dockerfile**: `ARG KUKAN_BRAND` + `ENV` in the web build stage; `KUKAN_BRAND` is in the `turbo.json` build task `env` so it enters the cache key
5. **Type checking**: `brands/` is in the `apps/web` tsconfig include (`**/*.ts`), so `pnpm typecheck` **checks every brand at once**; breaking changes to `BrandConfig` / `BrandOverrides` are caught for all brands in a brand-holding fork's CI
6. **Lint / tests**: the lint target is widened to `src brands` (so the default brand does not lose lint coverage). Core tests remain brand-independent via the `brand-defaults.ts` mock (the ADR-023 test strategy applies unchanged)

### Extending the fork operation rules

ADR-023's "fork changes are confined to the brand directory" stays, with the scope now being **under `brands/`**. A fork customizes `brands/default/` (to change the default look) and adds `brands/<name>/` (which consists solely of files that do not exist upstream, so there is no room for merge conflicts).

- Shared parts across brands go in `brands/_shared/` and are imported from each brand's `overrides/` (a horizontal version of the ADR-023 "reuse core components" pattern)
- Brand-specific npm dependencies are added to the fork's `apps/web/package.json`. Only the built brand's usage enters the bundle, so other brands' bundles do not grow
- Brand-specific tests live in `brands/<name>/__tests__/`

### Relation to deployment (ADR-041)

- Site definitions (`sites` in `environments.ts`) carry a brand name, and the pipeline builds web images per site with different `KUKAN_BRAND` values (tag example: `web-<site>-<version>`)
- The worker contains no brand, so a single image is shared by all sites
- CDK image assets are content-hashed, so **a brand-only change triggers a rolling deploy of that site only; other sites are a no-op**
- In non-AWS environments, write `KUKAN_BRAND` in the site compose `build.args`. The brand mechanism has no AWS / non-AWS differences

### Why `name` and `brand` are separate (not reused)

Keep a site's `name` (ADR-041) and `brand` as distinct axes; do not reuse `name` for `brand`:

- **One brand can be shared by several sites**: e.g. a prefecture brand used across its city sites — `{ name: 'citya', brand: 'gov' }` / `{ name: 'cityb', brand: 'gov' }`. Reusing `name` would force duplicating an identical `brands/<name>/` per site and undercut `brands/_shared/`
- **Works out of the box on the default brand (opt-in)**: `brand` unset → no `KUKAN_BRAND` passed → the default `brands/default/` is used. Reusing `name` would pass `KUKAN_BRAND=<name>` even for an un-customized multi-site environment, failing the image build when no `brands/<name>/` exists (an unknown build arg). That conflicts with ADR-041's goal of making multi-site the standard shape that runs on a bare configuration
- **Different constraints and layers**: `name` is a PostgreSQL identifier (16 chars, no hyphens) and belongs to infra identity (`environments.ts`); `brand` selects fork-owned content (`apps/web/brands/`) with no such naming constraint

### CSS variable rules are common to all brands

The theme-token contract — the `--color-*` mappings and `@theme inline` in `globals.css`, plus the rules each brand's `theme.css` follows (bare HSL triplets, paired tokens updated together, 4.5:1 contrast, light theme only, never touch `--color-*`) — is an **app-level contract** that sits outside the brand layer. Each brand's `theme.css` only swaps the raw token **values** under those same rules. Whichever brand is built, shared components reference the same token names, so there is no reason to vary the rules per brand; doing so would break the safety that ADR-023 and the brand-token policy guarantee (not breaking shadcn/ui internals).

## Trade-offs

- **Build time is linear in the number of brands**: the Next.js build for web runs once per site. Docker layers up to pnpm install are shared across brands, so the delta is effectively the single Next.js build stage. Mitigate with parallel asset builds and ECR layer caching (`cacheFrom`)
- **Brand changes also require a rebuild**: even swapping a single logo triggers an image build. If "change without rebuild" demand grows, migrate only the data-like items to option C (ADR-036 runtime settings) gradually
- **Two resolution paths**: the default goes through tsconfig paths while a set brand goes through the next.config alias (and vitest keeps its own alias). Strict per-brand type checking (including `@/brand` resolution) would need a separate `typecheck:brand` script that swaps paths

## Migration of existing forks

There is a one-time breaking change: the default brand moves from `src/brand/` to `brands/default/` (ADR-023's "existing forks are unaffected" is updated by this ADR).

- **Forks that edited `src/brand/`**: move the contents to `apps/web/brands/default/` (`git mv apps/web/src/brand apps/web/brands/default`). `@/brand` imports are unchanged, so no app-code changes
- **Forks that put assets in `public/brand/`**: move them to `apps/web/brands/default/public/` (`public/brand/` becomes generated and gitignored). The runtime URL `/brand/...` is unchanged
- Add further brands by copying `brands/default/` to `brands/<name>/`

## Consequences (changes at implementation time)

- `apps/web/brands/default/`: the default brand (moved from `src/brand/`)
- `apps/web/tsconfig.json`: add `@/brand` → `brands/default` to paths
- `apps/web/next.config.ts`: `KUKAN_BRAND` alias override (Turbopack / webpack)
- `vitest.config.ts` (root) / `apps/web/vitest.config.ts`: the web `@/brand` alias
- `apps/web/scripts/copy-brand-assets.mjs` + `package.json`: static asset copy, `public/brand/` gitignored
- `apps/web/package.json`: widen the lint target to `src brands`
- `Dockerfile` / `turbo.json`: `ARG KUKAN_BRAND` for the web build and the cache key
- Docs: add multi-brand steps to the fork customization guide

## Related

- ADR-023 (Brand override layer): this ADR extends it. The slot mechanism, type-change policy, and test strategy apply unchanged
- ADR-041 (Multi-site deployment): supplies images with per-site `KUKAN_BRAND` values
- ADR-036 (Runtime system settings): the landing place for future data-driven brand items (option C)
