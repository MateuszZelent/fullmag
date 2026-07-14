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

- [x] Dodać matrix axes none/X/XY/XYZ × demag open/truncated-images dla CPU i CUDA resolution; sprzeczne cases mają oczekiwać tego samego error.
- [x] Uruchomić planner/runner focused tests; macierz potwierdza wspólną legalność i wspólny błąd dla CPU/CUDA.

### Task 2: canonical resolution

```rust
enum ResolvedFdmDemagBoundary { Open, PeriodicTruncatedImages { images: [u32; 3] } }
```

- [x] Planner ma odrzucić `periodic axes + open` stabilnym capability reason zgodnym z note 0600.
- [x] CPU/CUDA construction przyjmują wyłącznie resolved enum; usunięto lane-specific reinterpretation.
- [x] Uruchomić `cargo test -p fullmag-plan fdm_pbc --no-fail-fast` i runner parity tests; PASS.

### Task 3: capability/provenance

- [x] Zaktualizować capability matrix i artifacts; uruchomić `./scripts/ci/contract_guard.sh --strict`.
- [x] Commit: wcześniejszy slice produkcyjny zawiera resolved boundary, runner construction i provenance; dowody poniżej.

**Exit:** identyczny request jest albo odrzucony, albo materializuje identyczną fizykę na CPU/CUDA.

### Evidence (2026-07-14)

- Planner matrix: `cargo test -p fullmag-plan fdm_pbc --no-fail-fast -- --nocapture` — 2 passed, including axes `none/X/XY/XYZ` × `open/truncated_images` for CPU and CUDA selection.
- Canonical resolver: `FdmPeriodicityIR::resolve_demag_boundary` returns `ResolvedFdmDemagBoundaryIR`; runner maps it to the shared engine enum before CPU/CUDA construction.
- Provenance: `mesh_runtime_metadata` preserves requested periodicity and `resolved_demag_boundary` for FDM single-grid and multilayer artifacts.
- Contract guard: `./scripts/ci/contract_guard.sh --strict` — passed.
