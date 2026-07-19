> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/042-multi-brand-build.md`](../jp/042-multi-brand-build.md).

# ADR-042: Multi-Brand Build (Brand Selection via `KUKAN_BRAND`)

## Status

**Proposed** — This ADR **extends** ADR-023 (brand override layer) rather than superseding it. The fork-oriented brand layer stays as is; a selection mechanism is added so a fork can hold multiple brands.

## Context

The ADR-023 brand layer assumes "1 fork = 1 brand": a fork edits `apps/web/src/brand/` directly. When a single fork operates multiple sites (ADR-041), it needs multiple brands, but with the current structure the only option is one fork per site — making upstream-tracking cost proportional to the number of sites.

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
├── src/brand/          ← default brand (unchanged, as today)
└── brands/             ← only an example in core; forks add brands here
    ├── example/        ← scaffolding sample (equivalent to a copy of src/brand)
    ├── _shared/        ← fork operator's shared parts (optional)
    └── <name>/         ← brand-config.ts / theme.css / messages/ / overrides/ / pages/ / public/
```

- `KUKAN_BRAND` unset → `src/brand/` is used as today. **Existing single-brand forks are entirely unaffected** (fully backward compatible, opt-in)
- `KUKAN_BRAND=<name>` → `@/brand` resolves to `apps/web/brands/<name>/`
- The location is `apps/web/brands/` rather than the repository root so that Next.js compilation scope, tsconfig includes, and alias resolution such as `@/components/*` stay self-contained within the app

### Mechanism (core-side implementation)

1. **Alias switching**: `next.config.ts` changes what `@/brand` resolves to based on `KUKAN_BRAND` (both webpack and Turbopack `resolveAlias`). Same for the vitest alias
2. **Static assets**: a prebuild script copies `brands/<name>/public/` → `public/brand/` (no copy when unset)
3. **Dockerfile**: add `ARG KUKAN_BRAND` to the web target
4. **Type checking**: include `brands/` in the `apps/web` tsconfig. Regardless of which brand is built, `pnpm typecheck` **checks every brand at once**, so breaking changes to `BrandConfig` / `BrandOverrides` are caught for all brands in CI when the fork pulls upstream
5. **Test discovery**: add `brands/**/__tests__/**` to the vitest include. Core tests remain brand-independent via the `brand-defaults.ts` mock (the ADR-023 test strategy applies unchanged)

### Extending the fork operation rules

Extend ADR-023's "fork changes are confined to `src/brand/`" to "**confined to `src/brand/` or `brands/`**". A fork-added `brands/<name>/` consists solely of files that do not exist upstream, so there is no room for merge conflicts (even more conflict-resistant than `src/brand/`).

- Shared parts across brands go in `brands/_shared/` and are imported from each brand's `overrides/` (a horizontal version of the ADR-023 "reuse core components" pattern)
- Brand-specific npm dependencies are added to the fork's `apps/web/package.json`. Only the built brand's usage enters the bundle, so other brands' bundles do not grow
- Brand-specific tests live in `brands/<name>/__tests__/`

### Relation to deployment (ADR-041)

- Site definitions (`sites` in `environments.ts`) carry a brand name, and the pipeline builds web images per site with different `KUKAN_BRAND` values (tag example: `web-<site>-<version>`)
- The worker contains no brand, so a single image is shared by all sites
- CDK image assets are content-hashed, so **a brand-only change triggers a rolling deploy of that site only; other sites are a no-op**
- In non-AWS environments, write `KUKAN_BRAND` in the site compose `build.args`. The brand mechanism has no AWS / non-AWS differences

## Trade-offs

- **Build time is linear in the number of brands**: the Next.js build for web runs once per site. Docker layers up to pnpm install are shared across brands, so the delta is effectively the single Next.js build stage. Mitigate with parallel asset builds and ECR layer caching (`cacheFrom`)
- **Brand changes also require a rebuild**: even swapping a single logo triggers an image build. If "change without rebuild" demand grows, migrate only the data-like items to option C (ADR-036 runtime settings) gradually
- **Dual tsconfig handling**: build-target switching goes through the resolve alias while type checking covers all brands via includes. Strict per-brand type checking (including `@/brand` resolution) needs a separate `typecheck:brand` script that swaps paths

## Consequences (changes at implementation time)

- `apps/web/next.config.ts`: alias switching via `KUKAN_BRAND` (webpack / Turbopack)
- `apps/web/brands/example/`: add the scaffolding sample
- `apps/web/package.json` / prebuild: static asset copy script
- `apps/web/tsconfig.json` / vitest config: include `brands/`
- `Dockerfile`: add `ARG KUKAN_BRAND` to the web target
- Docs: add multi-brand steps to the fork customization guide

## Related

- ADR-023 (Brand override layer): this ADR extends it. The slot mechanism, type-change policy, and test strategy apply unchanged
- ADR-041 (Multi-site deployment): supplies images with per-site `KUKAN_BRAND` values
- ADR-036 (Runtime system settings): the landing place for future data-driven brand items (option C)
