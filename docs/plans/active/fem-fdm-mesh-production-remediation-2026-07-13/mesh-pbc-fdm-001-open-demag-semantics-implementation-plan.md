# MESH-PBC-FDM-001 — Canonical FDM demag boundary semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć rozbieżność CPU/CUDA dla periodic axes z `pbc.demag="open"`.

**Architecture:** Zgodnie z physics note planner fail-closed odrzuca sprzeczną konfigurację albo rozwiązuje jawny, jednoznaczny demag strategy przed runtime. CPU i CUDA konsumują ten sam enum.

**Tech Stack:** Rust planner/engine/runner, CUDA runtime construction

## Global Constraints

- Najpierw uściślić `docs/physics/0600-periodic-boundary-conditions.md`.
- `open` nie może niejawnie znaczyć truncated images na jednej lane.
- Requested i resolved values są osobnymi polami provenance.

---

**Finding:** MESH-PBC-FDM-001, P0.
**Files:** `crates/fullmag-plan/src/fdm.rs`, `crates/fullmag-engine/src/fdm/shared/problem.rs`, CPU reference, CUDA construction, planner tests.

### Task 1: RED parity table

- [ ] Dodać matrix axes none/X/XY/XYZ × demag open/truncated-images dla CPU i CUDA resolution; sprzeczne cases mają oczekiwać tego samego error.
- [ ] Uruchomić planner/runner focused tests i potwierdzić obecny rozjazd.

### Task 2: canonical resolution

```rust
enum ResolvedFdmDemagBoundary { Open, PeriodicTruncatedImages { images: [u32; 3] } }
```

- [ ] Planner ma odrzucić `periodic axes + open` stabilnym capability reason zgodnym z note 0600.
- [ ] CPU/CUDA construction przyjmują wyłącznie resolved enum; usunąć lane-specific reinterpretation.
- [ ] Uruchomić `cargo test -p fullmag-plan fdm_pbc --no-fail-fast` i runner parity tests; PASS.

### Task 3: capability/provenance

- [ ] Zaktualizować capability matrix i artifacts; uruchomić `./scripts/ci/contract_guard.sh --strict`.
- [ ] Commit: `git add docs/physics/0600-periodic-boundary-conditions.md docs/specs/capability-matrix-v0.* crates/fullmag-plan crates/fullmag-engine crates/fullmag-runner && git commit -m "fix(fdm): unify periodic demag boundary semantics"`.

**Exit:** identyczny request jest albo odrzucony, albo materializuje identyczną fizykę na CPU/CUDA.
