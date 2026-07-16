# MESH-FEM-003 — Mesh build report preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachować requested-vs-realized `MeshBuildReport` od generatora do planu, artefaktu, API i Mesh Inspectora.

**Architecture:** Report jest immutable child resource bieżącego mesh build, identyfikowany build revision. Planner przenosi go bez semantycznej reinterpretacji.

**Tech Stack:** Python meshing, Rust IR/planner/API, OpenAPI, React resource hooks

## Global Constraints

- HTTP v2 jest źródłem snapshotu; websocket tylko invaliduje.
- Nie wkładać ciężkiego reportu do thin session status.
- Generated transport jest jedynym frontendowym access path.

---

**Finding:** MESH-FEM-003, P1.
**Files:** `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`, `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`, `crates/fullmag-ir/src/mesh_assets.rs`, `crates/fullmag-plan/src/mesh.rs`, `crates/fullmag-ir/src/plan.rs`, `crates/fullmag-api/src/schemas/mesh.rs`, `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`, `apps/control-room/src/shared/domain/mesh/buildPipeline.ts`, `apps/control-room/src/modules/inspector/panels/mesh-details/useMeshDetailsModel.ts`.

### Task 1: RED — end-to-end fixture

- [ ] Zbudować fixture z requested size field i realized fallback; asercje na tych samych polach w `FemPlanIR`, artifact JSON, API response i Inspector model.
- [ ] Uruchomić focused Python/Rust/UI tests; potwierdzić pierwsze miejsce utraty reportu.

### Task 2: GREEN — immutable report resource

```rust
pub struct ResolvedFemDomainMeshAsset { pub build_report: Option<MeshBuildReportIR>, /* existing */ }
```

- [ ] Przenieść pole przez resolved asset i plan; zapisać artifact z build/topology fingerprint.
- [ ] Rozszerzyć OpenAPI, wygenerować klienta, dodać facade/hook i semantyczny Inspector section.
- [ ] Uruchomić `cargo test -p fullmag-plan mesh --no-fail-fast`, API tests i focused UI tests; PASS.

### Task 3: gates

- [ ] Uruchomić `pnpm --dir apps/control-room generate:api`, `typecheck`, `lint`, `test`, `check:api-hygiene`.
- [ ] Commit: `git add packages/fullmag-py crates/fullmag-ir crates/fullmag-plan crates/fullmag-api apps/control-room && git commit -m "feat(mesh): preserve build reports across runtime resources"`.

**Exit:** report z jednego build revision jest identyczny semantycznie w planie, artifact, API i Inspector; rebuild unieważnia stary resource.

## Evidence update (2026-07-14)

- [x] Existing IR/planner/runner/API/Inspector path preserves `FemSharedDomainBuildReportIR`; generated OpenAPI already exposes the report and the Inspector model reads it as a named mesh detail.
- [x] `cargo test -p fullmag-plan mesh --lib --no-fail-fast` — 29 passed.
- [x] `cargo test -p fullmag-api mesh_semantics_returns_three_level_projection` — 1 passed.
- [x] `cargo test -p fullmag-runner --lib --no-fail-fast` — 506 passed (includes shared-domain report propagation fixture).
- [ ] Python end-to-end fixture, managed OpenAPI hygiene and Control Room browser/UI test remain open; local UI focused test is blocked by absent `apps/control-room/node_modules` (`vitest: not found`).

### Evidence update (2026-07-14, CLI consumer closure)

- [x] Fixed the remaining CLI test-consumer omissions by initializing `FemMeshPayload.build_report` and `FemFrequencyResponsePlanIR.mesh_build_report` in live-workspace and frequency-response fixtures.
- [x] RED/GREEN evidence: the targeted CLI test initially failed at those three missing fields; after the surgical additions `cargo test -p fullmag-cli orchestrator::tests::attach_region_realization_revisions --no-fail-fast -- --nocapture` passed 2/2 and `cargo test -p fullmag-runner artifacts::tests::metadata_execution_provenance_persists_resolved_fallback --no-fail-fast -- --nocapture` passed 1/1.
- [ ] Python end-to-end, managed OpenAPI hygiene and browser/Inspector gates remain open.
