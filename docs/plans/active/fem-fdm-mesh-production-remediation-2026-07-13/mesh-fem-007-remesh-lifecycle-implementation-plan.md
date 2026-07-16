# MESH-FEM-007 — Atomic remesh lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zmieniać mesh atomowo wraz z reportem, marker universe, material maps, transferem stanu i invalidation.

**Architecture:** Remesh transaction buduje candidate, waliduje wszystkie zależne kontrakty, transferuje stan, a dopiero potem publikuje nową mesh generation. Failure pozostawia poprzednią generację current.

**Tech Stack:** Rust CLI orchestrator/planner, Python remesh, resource revisions

## Global Constraints

- Brak częściowo opublikowanej nowej topologii.
- Każda nowa topologia ma nowy fingerprint i unieważnia stare certyfikaty.
- Transfer state jest auditowany przed commit transaction.

---

**Finding:** MESH-FEM-007, P1.
**Files:** `crates/fullmag-cli/src/orchestrator.rs`, `crates/fullmag-plan/src/mesh.rs`, `packages/fullmag-py/src/fullmag/meshing/_gmsh_remesh.py`, `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`, `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`, `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`.

### Task 1: RED — failure atomicity

- [ ] Dodać tests dla failure po generation, validation, material remap i state transfer; current mesh revision musi pozostać stara w każdym przypadku.
- [ ] Uruchomić focused orchestrator remesh tests; potwierdzić przypadki częściowej publikacji.

### Task 2: transaction

```rust
struct RemeshCandidate { mesh: MeshIR, report: MeshBuildReportIR, topology_hash: String }
fn commit_remesh(candidate: RemeshCandidate, transfer: StateTransferAudit) -> Result<MeshGeneration, RemeshError>;
```

- [ ] Rozdzielić prepare/validate/transfer/commit; publish revision tylko w `commit_remesh`.
- [ ] Walidować marker universe, material maps i strict MeshIR; invalidować dependent certificates po commit.
- [ ] Uruchomić CLI/planner/API lifecycle tests; PASS.

### Task 3: evidence

- [ ] Zarejestrować before/after revisions, topology hashes i transfer norms w artifact.
- [ ] Commit: `git add crates/fullmag-cli crates/fullmag-plan packages/fullmag-py crates/fullmag-api && git commit -m "fix(fem): make remesh publication atomic"`.

### Bounded implementation evidence — 2026-07-14

- [x] Added `prepare_remesh_stage_transaction` in `crates/fullmag-cli/src/orchestrator.rs`; stage IR and execution plans are prepared on private candidate snapshots and copied into the live slices only after marker validation and replanning succeed.
- [x] Applied the candidate/commit boundary to manual interactive remesh, adaptive FEM follow-up, and FEM auto-coarsen. Auto-coarsen no longer publishes an over-budget candidate before trying the next hmax.
- [x] Periodic candidates in auto-coarsen are now recertified through `validate_periodic_remesh_candidate` before any commit.
- [x] Added `remesh_transaction_keeps_sources_unchanged_when_candidate_validation_fails`; focused run and the full orchestrator module pass (`67 passed, 0 failed`).

Remaining for full closure: generation/material-remap/state-transfer fault injection, explicit mesh-generation/revision artifact transaction in the API/resource layer, native managed remesh runtime, and browser lifecycle evidence. This bounded slice does not close those gates.

**Exit:** każda porażka pozostawia spójny stary mesh; sukces publikuje kompletną nową generation jednym revision eventem.
