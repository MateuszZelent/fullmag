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

**Exit:** każda porażka pozostawia spójny stary mesh; sukces publikuje kompletną nową generation jednym revision eventem.
