# AGENTS.md

## What this repo is

**Komari-Theme-LuminaPlus** — a frontend theme (SPA) for the [Komari](https://github.com/komari-monitor/komari) server-monitoring panel, shipped as a ZIP that users upload in Komari's theme manager. It is an enhanced fork of `komari-theme-Lumina`. React 19 + TypeScript (strict) + Vite + Tailwind CSS 4 + uPlot charts + TanStack Query + zod.

The theme runs **same-origin under the Komari backend**: it calls `/api/*` (REST + RPC2 over `/api/rpc2`), receives live status over WebSocket, and manages Komari's own service worker (`/sw.js`). There is no backend code here.

Repo language is Chinese (README, code comments, user-facing strings). Follow that convention.

## Commands

包管理器是 **pnpm**(不要用 npm;仓库里遗留的 package-lock.json 已过时)。

```bash
pnpm dev               # Vite dev server; append ?mock=1 for full mock data without a backend
pnpm typecheck         # tsc -b (project references)
pnpm lint              # eslint
pnpm test              # vitest run (pnpm test:watch for watch mode)
pnpm build             # tsc -b && vite build → dist/
pnpm package           # build + make-preview + package-zip → Komari-Theme-LuminaPlus-v{version}.zip
pnpm release           # scripts/release.mjs: version-align check + typecheck + build + package
```

Dev mock: `pnpm dev --host 0.0.0.0` then open `?mock=1` (add `&admin=1` to also unlock `/api/admin/*` for ThemeManage debugging). Mock mode is DEV-only; `src/dev/mockApi.ts` patches `window.fetch` and returns standard errors for unimplemented RPC methods.

## Layout

- `src/services/api.ts` — all Komari backend calls; every response is validated with zod envelopes. `rpc2Client.ts` (RPC2), `wsStore.ts` (WebSocket status).
- `src/types/komari.ts` — zod schemas + inferred types for Komari API payloads.
- `src/utils/` — pure, framework-free logic (traffic/ping metrics, formatting, billing, background rules, theme-setting normalization). **Most tests live here** — keep logic extractable and pure; tests are colocated in `__tests__/` and are `.test.ts` logic tests, not component-render tests.
- `src/hooks/` — react-query-backed hooks (`useThemeSettings`, `usePublicConfig`, `useTodayTrafficStats`, …).
- `src/components/` — `node/` (node cards/grid/list), `instance/` (uPlot ping/load charts), `shell/` (background layer, floating controls, PWA pull-to-refresh, error boundary), `ui/`, `traffic/`, `theme/`.
- `src/pages/` — Home, Instance, Traffic, Assets (lazy-loaded), ThemeManage, NotFound. Routes in `src/router.tsx`.
- `src/styles/` — hand-written CSS; design tokens in `styles/tokens.css`. Tailwind 4 via `@tailwindcss/vite`.
- `scripts/` — `release.mjs`, `package-zip.mjs` (hand-rolled ZIP writer, no archiver dep), `make-preview.mjs`.
- `public/assets/` — copied verbatim into `dist/assets/` and included in the theme ZIP (flag SVGs, OS logos, built-in background video).

## Rules and gotchas

1. **Version sync**: `package.json` version must equal `komari-theme.json` version. `npm run release` hard-fails otherwise; the ZIP name comes from `komari-theme.json`. Bump both together.
2. **Releases**: CI (`.github/workflows/build-package.yml`) runs on tags `v*` and publishes a GitHub release; it requires `.github/release-notes/vX.Y.Z.md` to exist for tag `vX.Y.Z` or the publish step fails. Commit style: `Release v1.3.5`.
3. **`index.html` inline script is load-bearing**: it reads localStorage (appearance, `komaritheme:dark-depth`, `komaritheme:bg`) and sets CSS custom properties *before* React boots to avoid FOUC. If you change appearance/background storage keys or semantics in `src/`, mirror the change in that inline script.
4. **CSS tokens are `:root`-only**: `styles/tokens.css` declares tokens only on `:root` (see its comment) so html-level custom palettes aren't overridden by elements carrying `data-appearance`. Don't redeclare tokens on cards/containers.
5. **Browser baseline**: build target is `es2022 / chrome111 / safari16.2 / firefox113` (see `vite.config.ts`). `color-mix()`/oklch are used freely; no need to support older engines.
6. **Theme settings flow**: server-sent `theme_settings` (public config) → `normalizeThemeSettings` in `src/utils/themeSettings.ts` → `useThemeSettings()`. To add a setting: extend the raw schema/defaults in `themeSettings.ts`, add UI in `src/pages/ThemeManage.tsx` (rendered on Home with `?view=theme-manage`), and add tests. Settings must degrade gracefully to defaults when the server has none.
7. **`/admin` paths are intercepted**: `main.tsx` renders `AdminRecovery` instead of the app for `/admin*` and delegates to Komari's admin. Don't route these through the SPA router.
8. **Background video gating**: the desktop video background only loads on wide, non-touch, non-`prefers-reduced-motion`, non-save-data clients (`index.html` pre-parse + `utils/backgroundVideoSession.ts`). Custom videos go in `public/assets/` and must not share the built-in filename `LanternRivers_1080p15fps2Mbps3s.mp4`.
9. **Path alias**: `@/` → `src/` (configured in both `vite.config.ts` and tsconfig `paths`). Use it, not relative `../..` imports.
10. **Line endings**: `.gitattributes` forces LF (`text=auto eol=lf`); images/fonts are binary.
11. **Manual chunks** in `vite.config.ts` group vendor deps (react/query/charts/validation) — new heavyweight deps may need a chunk entry to keep the initial bundle small.
12. **Chart Y axes**: never use bare `y: { auto: true }` for quasi-static metrics (disk, connections, rates) — auto-zoom turns sub-1% drift into a full-height "spike". Use `buildYScale()` from `chartShared.ts` (`fixed` / `anchorZero` / `minSpan`) and format ticks with `pickAxisDecimals()` so labels don't collide at tiny spans. `PingChart.tsx`'s hand-rolled `yRange` predates this helper and follows the same idea.
13. **Realtime seed & the server's raw window**: Komari's metric store keeps exact raw samples in memory for a fixed **10 minutes** (`DefaultRollupRawRetention`); `public:queryMetrics` serves them (`downsampled: false`) only when the requested window is ≤10 min and ends within the last 10 min — otherwise the whole query comes from rollup buckets (1min/5min/1h). The load-chart realtime mode therefore seeds with `getLoadRealtimeSeed()` = 20 min of 1-min buckets + 10 min of raw samples (two windowed queries; falls back to the 1-hour records chain on old backends), then appends the 2-second `wsStore` points. Raw-segment gaps are NOT gap-filled/interpolated (missing samples = real reporting stops); the bucket segment is.
