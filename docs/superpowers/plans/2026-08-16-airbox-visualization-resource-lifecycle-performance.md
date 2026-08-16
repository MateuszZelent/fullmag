# Airbox Visualization Resource Lifecycle and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zrealizować wszystkie wymagania audytu wizualizacji Airboxa dla FDM single-grid, FDM multilayer i FEM oraz zamknąć je kwalifikacją runtime.

**Architecture:** Backend zapisuje quantity-aware readiness i generacyjny carrier, a API v2 jest jedynym źródłem snapshotów. Frontend utrzymuje per-target resources z partial loading, last-good adoption i jawnie bounded samplingiem; immutable topology pozostaje niezależna od pola. Inspektor i renderer współdzielą target-aware capacity descriptor.

**Tech Stack:** Rust/Axum/utoipa, generated OpenAPI v2, React 19/TypeScript, React Three Fiber/Three.js, Vitest, Playwright smoke, managed `just` runtime recipes.

## Global Constraints

- Raporty, plany, audyty i podsumowania zapisuj po polsku; kod i nazwy pozostają po angielsku.
- Zmiany API przechodzą przez schema → OpenAPI → generated types/transport → `ControlRoomApi` → resource hooks.
- HTTP v2 jest źródłem prawdy; realtime wyłącznie invaliduje zasoby.
- FDM/FEM pozostają jednym viewportem z adapterami domenowymi.
- Quantity switch nie może zmieniać klucza/rebuildować topology.
- Nie wolno syntetyzować pola ani cicho przechodzić na inny backend/device/precision.
- Native FEM/MFEM/CUDA/hypre/libCEED weryfikuj przez repozytoryjne `just` recipes.
- Zachowaj istniejące dirty-worktree zmiany w `.impl-racetrack` i submodułach.
- Każdy etap jest TDD: RED, potwierdzenie oczekiwanej porażki, GREEN, focused verification.

---

### Task 1: Quantity-aware command readiness and generational carrier publication

**Files:**
- Modify: `crates/fullmag-api/src/types.rs`, `crates/fullmag-api/src/schemas/runtime.rs`, `crates/fullmag-api/src/schemas/commands.rs`, `crates/fullmag-api/src/session.rs`, `crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs`, `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`.
- Modify: `crates/fullmag-cli/src/live_workspace.rs`, `crates/fullmag-cli/src/orchestrator.rs`, `crates/fullmag-cli/src/interactive_runtime_host.rs`.
- Test: corresponding Rust module tests and `crates/fullmag-api/src/router_v2/tests.rs`.

**Interfaces:**
- Produce `FieldMaterializationRequirement { quantity_ids, scope_kind, scope_id, generation_id, carrier_fingerprint }` on `compute_fields` records.
- Produce `command_readiness_matches_requirements(record, snapshot) -> Result<bool, String>`.
- Produce immutable generation directory plus atomic manifest pointer for multilayer auxiliary artifacts.

- [ ] **Step 1: RED tests** — add tests proving a compute command with missing `H_demag`/Airbox carrier cannot become completed, while all required resources readable through the public resolver do; add publication test that a reader sees either old or new manifest/payload pair, never a mixed pair.
- [ ] **Step 2: Run RED** — `cargo test -p fullmag-api session::tests::snapshot_reconciliation_marks_compute_fields_terminal_from_preview_cache` and targeted CLI tests; expected failure on the old broad readback condition.
- [ ] **Step 3: Implement** — derive requirements at enqueue time from canonical materialization quantities and current domain generation, attach them to `SessionCommand`, validate each quantity/scope/carrier before terminal completion, and publish artifacts under generation-specific paths with one atomic pointer rename.
- [ ] **Step 4: GREEN** — run the same focused API/CLI tests and `cargo fmt --check`.
- [ ] **Step 5: Contract tests** — add exact `POST compute_fields -> command detail -> each required resource` assertions for FDM single-grid, multilayer and FEM fixtures.

### Task 2: Explicit pending/conflict vector protocol and sampled multilayer transport

**Files:**
- Modify: `crates/fullmag-api/src/schemas/fields.rs`, `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `crates/fullmag-api/src/router_v2/tests.rs`.
- Modify generated artifacts via `pnpm --dir apps/control-room generate:api`.
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`, `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`.

**Interfaces:**
- Produce `FieldVectorPendingResponse { state, reason_code, retry_after_ms, command_id, quantity_id, scope_kind, scope_id, generation_id }` with HTTP 202.
- Extend `BinaryResourceResult` with `pending` and preserve `not-applicable` for 204.
- `ControlRoomApi.data.fields.vector` retries 202 only through the bounded materialization path and exposes reason metadata.

- [ ] **Step 1: RED tests** — assert pending field returns 202 JSON, missing identity returns 404, carrier mismatch returns 409, and multilayer `max_samples=1` returns one point with explicit ordinals.
- [ ] **Step 2: Run RED** — focused Rust API and `ControlRoomApi.test.ts`; expected failures against 204/404/complete-payload behavior.
- [ ] **Step 3: Implement** — add schema/status mapping, expected generation query/precondition validation, sampled FMVP v3 serialization for native grids, cache/ETag tokens including budget and ordinals, and typed facade handling.
- [ ] **Step 4: GREEN** — regenerate OpenAPI/types/transport and run API tests, typecheck and `check:api-hygiene`.

### Task 3: Per-target resource lifecycle, retry/deadline and last-good adoption

**Files:**
- Modify: `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts`, `apps/control-room/src/kernel/resources/useResource.ts`.
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`.
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts`, `apps/control-room/src/kernel/resources/ResourceRuntimeStore.test.ts`, `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`.

**Interfaces:**
- Produce `ResourceRetryPolicy` with reason-code allowlist, deadline and `retry_after_ms`.
- Produce per-request `useViewport3DFieldVectorRequest` entries and a derived collection retaining previous data per request id.
- Produce `resolveViewport3DDisplayedLiveValue` wired into the production scene model.

- [ ] **Step 1: RED tests** — fail on 404→pending→200 without external invalidation, partial collection preserving target A while B is pending/error, and last-good data retained during revision change.
- [ ] **Step 2: Run RED** — focused Vitest with fake timers.
- [ ] **Step 3: Implement** — add autonomous bounded retry/deadline in runtime store, preserve settled data on loading/error, classify 202/404/409, replace `Promise.all` collection with per-request entries, and adopt only matching request/generation identity.
- [ ] **Step 4: GREEN** — run resource/viewport tests and inspect request diagnostics for request id, target, quantity, scope, bytes and duration.

### Task 4: Stable topology, sampled vector worker and global glyph allocator

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts`, `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildScheduler.ts`, `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.ts`, `apps/control-room/src/modules/viewport-3d/model/viewport3DFdmMultilayerAirbox.ts`, `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.ts`, `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`.
- Create/modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DVectorBudgetAllocator.ts` and tests.

**Interfaces:**
- Produce topology key independent of quantity/field readiness.
- Produce sampled vector build request accepting anchors/values/ordinals without full cuboid model.
- Produce `resolveViewport3DGlobalVectorAllocation(targets, cap)` with deterministic effective allocations and degradation reason.

- [ ] **Step 1: RED tests** — prove quantity switch keeps topology key/model identity, sampled payload pointCount ≤ budget, global cap is respected, and worker fallback count/reason is bounded.
- [ ] **Step 2: Run RED** — focused model/scheduler/state tests.
- [ ] **Step 3: Implement** — retain last ready topology result in build state, split vector-only build path, send `max_samples` for multilayer, wire allocator and preserve worker latest-wins/cleanup.
- [ ] **Step 4: GREEN** — run all FDM build/glyph/lifecycle tests plus `audit:idle-performance`.

### Task 5: Target patch merge and target-aware Inspector accounting

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`, `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`, related tests.
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`, `ObjectVisualizationPanel.tsx`, `VisualizationVectorAccountingRows.tsx`, `ObjectVisualizationTargetSection.tsx`, `VisualizationVectorAccountingRows` tests and DOM tests.
- Modify/create target capacity adapter under `apps/control-room/src/modules/viewport-3d/model/` shared by planner/renderer/Inspector.

**Interfaces:**
- Produce identity merge for `(scope, scope_id)` and revision-safe optimistic patch queue.
- Produce `VisualizationVectorCapacityDescriptor` with `fullCount`, `surfaceCount`, `anchorKind`, `carrierId`, `generation`, `exact`.
- Produce accounting fields `available`, `requested`, `allocated`, `decoded`, `adopted` with quantity/scope/revision identity.

- [ ] **Step 1: RED tests** — interleaved A/B patches retain both overrides; FDM total 199680/active1600 gives Airbox 198080; `Surface` differs from `Full`; native layer uses own counts; non-Airbox accounting resolves current snapshot; opening ordinary Inspector does not scan values.
- [ ] **Step 2: Run RED** — focused model/controller/DOM tests.
- [ ] **Step 3: Implement** — merge optimistic registry state by target identity, add capacity adapter from FMRM/native/FEM carriers, show distinct labels/units and effective clamp, and make debug scan explicit-demand only.
- [ ] **Step 4: GREEN** — run Inspector family tests and targeted lint/typecheck.

### Task 6: Observability, benchmark and browser qualification

**Files:**
- Modify: `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs` and related audit helpers.
- Create: `apps/control-room/scripts/audit-airbox-vector-cold-toggle.mjs`, fixtures and evidence manifest.
- Modify: `docs/audits/2026-08-16-airbox-visualization-resource-lifecycle-performance-audit.md` with verified status/evidence.

**Interfaces:**
- Benchmark reports 20 cold + 20 warm trials per FDM single-grid, multilayer and FEM lane: request/bytes/pointCount/decode/transfer/worker/glyph/GPU/first glyph/long tasks/dirty frames/draw calls/heap/WebGL/workers/fallbacks.
- Browser gate asserts canvas visibility, non-lost WebGL and nonzero drawing buffer after each transition.

- [ ] **Step 1: RED harness assertions** — add missing metrics and fail if absent rather than reporting zero.
- [ ] **Step 2: Implement instrumentation/harness** — use existing dev-server and smoke ownership rules, no killing unrelated server.
- [ ] **Step 3: Run qualification** — managed runtime/API setup, cold/warm matrix, 50 rapid vector toggles, 100 quantity changes with ≥3 targets, 100 3D↔2D transitions, worker fallback lane and separate wireframe-off frame.
- [ ] **Step 4: Record evidence** — store JSON/PNG/log artifacts under existing audit artifact root and update the audit table with implemented/production-executable/validated distinctions.

### Final verification

- [ ] Run `git diff --check`, focused tests, full `pnpm --dir apps/control-room test`, typecheck, lint, `check:api-hygiene`, `audit:idle-performance`, and relevant managed `just` recipes.
- [ ] Re-read every numbered audit requirement and map it to current source plus fresh command/runtime evidence.
- [ ] Request final code review for the complete diff and fix all Critical/Important findings.
- [ ] Only after all gates pass mark the active goal complete.
