# Frontend v2 - Testing and Quality Gates

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Test Pyramid

| Layer | Tests |
|---|---|
| Kernel | registry, bus, layout, command registry, module lifecycle |
| API | generated type freshness, facade modules, resource hooks, command adapters, realtime invalidation |
| Domain | FDM/FEM adapters, render model builders, units |
| Modules | manifest, root behavior, store, command/menu/ribbon contributions |
| Viewport | renderer lifecycle, resource tracker, dirty loop, picking |
| Integration | explorer-selection-inspector, command-ribbon-runtime, 3D/2D/charts resource flow |
| Visual/perf | screenshots, idle audit, memory stress |
| Design | Catppuccin Mocha/Latte token mapping, import-only globals, shadcn/ui-style primitive usage |

## 2. Required Gates Per Change

| Change touches | Required verification |
|---|---|
| module manifest/root | registry test, module boundary import check |
| API/resource hook | typecheck, resource hook test, direct-fetch check |
| command | command registry test, one renderer path test |
| state store | store unit test and cross-module import check |
| inspector edit | draft/validate/commit/failure tests |
| viewport renderer | lifecycle test, dirty-loop test, resource cleanup test |
| Analysis or Quick Chart | unit/dimension model test, relevant/irrelevant invalidation, real renderer cleanup, request/model/redraw audit, 3D coexistence stress, screenshot and keyboard/a11y proof |
| geometry object lifecycle | scene transaction hook test, explorer badge test, inspector draft/commit/rejection test, command gate test, primitive/fallback wireframe viewport test, mesh-build invalidation test |
| CSS/layout | design contract test, screenshot or visual check once implementation exists |
| interactive chrome | shadcn/ui-style primitive usage test and accessibility check |
| migration/cutover | legacy import/route scan and acceptance checklist |

## 3. Static Checks

Initial checks:

```bash
rg "fetch\\(" apps/control-room/src
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src
rg "/v2/" apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
rg "from ['\"]\\.\\./" apps/control-room/src/modules
rg "createContext" apps/control-room/src
```

The module import check needs a real script before implementation starts. Grep is acceptable only as an initial guard.

## 4. Generated API Freshness

OpenAPI changes require:

1. backend route/schema tests;
2. generated v2 JSON update;
3. generated v2 TS types update;
4. generated v2 client update;
5. facade/resource hook tests;
6. frontend typecheck.

Generated files are never manually edited.

## 5. Visual Verification

UI changes require visual verification once the v2 app exists:

- before/after screenshot for layout or visual polish;
- specific viewport screenshot for rendering changes;
- reduced-motion check when adding animation;
- narrow screen check for shell/drawer behavior.

Visual verification is not a substitute for API/state/render lifecycle tests.

Geometry object lifecycle visual verification must cover: add primitive, edit dimensions/position/rotation, confirm immediate primitive display, enable fallback wireframe before mesh exists, run mesh build, and confirm current topology replaces primitive mesh mode without losing selection.

## 6. Performance Verification

Performance claims require evidence:

- baseline measurement;
- changed measurement;
- exact scenario;
- profiler output or audit summary;
- no new architecture exceptions.

Memory leaks require stress loops, not one manual click path.

## 7. Completion Rule

A frontend v2 task is not complete if:

- it leaves dead module registrations;
- it copies legacy helpers without owning their removal;
- it has no test or explicit verification reason;
- it bypasses OpenAPI/resource hooks;
- it reintroduces preview/bootstrap/poll as canonical vocabulary;
- it changes user-visible physics semantics without Python/IR/API implications.
