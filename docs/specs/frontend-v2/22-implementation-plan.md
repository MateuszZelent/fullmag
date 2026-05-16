# Frontend v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clean modular Fullmag control-room frontend in `apps/control-room` and retire `apps/legacy_web` as active frontend after validated parity.

**Architecture:** A thin kernel hosts manifest-driven modules in stable slots. Data flows from OpenAPI v2 through generated transport, handwritten API facade, resource hooks, codecs, and domain adapters. UI commands flow through one command registry rendered by menu, ribbon, toolbars, shortcuts, and palette.

**Tech Stack:** Next.js 16, React, TypeScript, Zustand, Tailwind CSS, shadcn/ui, OpenAPI-generated TypeScript, Three.js, ECharts, Vitest, ESLint. Desktop: Tauri first; Electron only as fallback.

---

## Phase 0 - Documentation and Guardrails

- [ ] Create frontend-v2 spec index and detailed docs under `docs/specs/frontend-v2`.
- [ ] Add ADR for module-kernel and legacy sunset decision.
- [ ] Add frontend-v2 skills under `.agents/skills`.
- [ ] Update `AGENTS.md` with frontend-v2 doctrine.
- [ ] Verify docs and skill files contain no ambiguous placeholders.

## Phase 1 - Kernel Skeleton

- [ ] Create `apps/control-room` package and scripts.
- [ ] Keep the app on Next.js 16 unless an explicit version-change decision is made.
- [ ] Configure Vitest, TypeScript, ESLint, and build scripts as zero-tolerance gates from the first commit.
- [ ] Create import-only `app/globals.css` and central `src/design/styles/*` token/theme/layout files.
- [ ] Implement Catppuccin Mocha/Latte dark/light theme foundation through `data-theme` and token swapping.
- [ ] Add shadcn-compatible shared UI foundation (`components.json`, `cn`, first shared button primitive) and use it for interactive chrome instead of bespoke widgets.
- [ ] Add platform runtime target detection for `web`, `tauri`, and `electron` without direct module-level native imports.
- [ ] Create `KernelProvider`, `KernelApi`, `ModuleRegistry`, `EventBus`, `CommandRegistry`.
- [ ] Create `WorkspaceShell`, slot hosts, module boundary, status placeholder.
- [ ] Add tests for registry, bus, duplicate command rejection, module boundary rendering, design entrypoint, theme preference, platform runtime target, and shared UI primitives.
- [ ] Verify app starts with zero optional modules registered.
- [ ] Verify `pnpm --dir apps/control-room test`, `typecheck`, `lint`, and `build` before reporting completion.

## Phase 2 - API Spine

- [x] Add OpenAPI v2 generation pipeline.
- [x] Port generated transport and API facade pattern.
- [x] Port request-id, retry, version, diagnostics interceptors.
- [x] Port binary codecs with tests.
- [x] Build base `useResource` hook and session status hook.
- [x] Build realtime invalidation bridge.
- [x] Verify no module direct fetch and no v1/live references.

Phase 2 local gate status on 2026-05-11:

- `pnpm --dir apps/control-room generate:api`, `typecheck`, `lint`, `test`, and `check:api-hygiene` pass.
- `pnpm --dir apps/control-room build` passes when run outside the restricted sandbox. Inside the sandbox, Turbopack/PostCSS still cannot create its helper process and fails with `Operation not permitted (os error 1)`.

## Phase 3 - Shell, Menu, Ribbon, Status, Visual Foundation

- [ ] Expand shadcn/ui component coverage with menu, ribbon controls, command, dialog, dropdown, context menu, tabs, tooltip, switch, segmented control, and resizable panel primitives.
- [ ] Implement user-facing theme switcher using the Phase 1 `ThemeProvider`.
- [ ] Implement main menu as command registry renderer using shadcn/ui components.
- [ ] Implement ribbon as context command-group renderer.
- [ ] Implement command palette using shadcn/ui `Command` component.
- [ ] Implement status bar from session/status resources.
- [ ] Implement project-start module (open/recent/example session flow).
- [ ] Add command shortcut scope resolution.
- [ ] Apply micro-animations: hover transitions, overlay open/close, selection highlight.
- [ ] Verify one command runs from menu, ribbon, shortcut, and palette.
- [ ] Visual review: the shell must look polished and premium, not utilitarian.

## Phase 4 - Explorer, Selection, Inspector, Authoring Modules

- [ ] Implement explorer module and tree node model builders.
- [ ] Implement kernel selection store and selection events.
- [ ] Implement inspector module and panel registry.
- [x] Add per-object and airbox `Visualization` explorer nodes plus inspector panels backed by the visualization target registry.
- [ ] Implement draft transaction flow for the first safe property edits.
- [ ] Implement Geometry object creation lifecycle from `24-geometry-object-authoring-lifecycle.md`: new primitive draft, backend create transaction, post-commit object selection, primitive-only display state, stale mesh badges, and selected-object mesh build command.
- [x] Add first backend-backed `object.physics` inspector slice for per-object magnetic interactions using `/model/objects/{object_id}/interactions/{interaction_kind}`.
- [x] Add first backend-backed `object.material` inspector slice for material assignment using `/model/objects/{object_id}`.
- [x] Add first backend-backed `object.mesh` inspector slice for per-object mesh policies using `/meshing/policies/objects/{object_id}`.
- [ ] Implement authoring modules alongside inspector panels:
  - [ ] `definitions` — parameters, named quantities.
  - [ ] `materials` — material assignment, tensor/scalar editing.
  - [ ] `physics` — interactions, boundary conditions, external fields.
  - [ ] `geometry-authoring` — primitives, transforms, booleans in unified viewport.
  - [ ] `mesh-authoring` — universe/object/shared-domain mesh controls.
  - [ ] `study-authoring` — stage pipeline, execution intent, backend request.
  - [ ] `python-export` — canonical DSL preview/export.
- [ ] Verify selection updates explorer, inspector, ribbon gates, and viewport highlight.

## Phase 5 - 3D Viewport

- [ ] Implement `viewport-3d` module shell and store.
- [ ] Build domain-neutral render model adapters.
- [ ] Implement scene controller and layer renderers.
- [x] Apply target visualization overrides independently for each scene object, mesh part, and airbox target.
- [ ] Render newly created/unmeshed Geometry objects through primitive surfaces and simplified fallback wireframe before solver topology exists.
- [ ] Implement dirty render loop and resource tracker.
- [ ] Add mesh/topology/field resource hooks.
- [ ] Verify quantity switches do not rebuild topology and idle frames stop.

## Phase 6 - 2D, Charts, Console, Results

- [ ] Implement `viewport-2d` slice/profile module.
- [ ] Reuse the object/airbox visualization target registry for 2D slice layers before adding 2D-specific override fields.
- [ ] Gate 2D object-scoped slice/profile commands for primitive-only or mesh-stale Geometry objects with explicit disabled/stale explanations.
- [ ] Implement charts module and scalar series model.
- [ ] Implement engine console from log resources.
- [ ] Implement results navigator from artifact/analysis resources.
- [ ] Verify 2D/3D split, charts update, and console log rendering.

## Phase 7 - Performance and Cutover

- [ ] Add idle performance audit.
- [ ] Add viewport memory stress test.
- [ ] Add module boundary and direct transport CI checks.
- [ ] Run side-by-side workflow comparison against legacy.
- [ ] Visual polish review: Catppuccin Mocha/Latte themes, transitions, typography, shadcn consistency.
- [ ] Switch default dev/deploy scripts to v2 only after acceptance passes.
- [ ] Freeze `apps/legacy_web`, then remove it after the release-cycle criteria pass.

## Phase 8 - Desktop Packaging (Tauri)

- [ ] Add Tauri project configuration alongside Next.js.
- [ ] Implement platform abstraction for file dialogs and system integration.
- [ ] Configure API base URL switching (localhost for desktop, configurable for web).
- [ ] Verify all modules work in Tauri WebView without SSR dependencies.
- [ ] Add desktop-specific features: system tray, native menus, window management.
- [ ] Build and test desktop distribution for Linux, macOS, and Windows.
