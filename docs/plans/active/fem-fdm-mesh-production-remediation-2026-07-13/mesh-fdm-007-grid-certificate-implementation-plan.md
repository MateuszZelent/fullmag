# MESH-FDM-007 — Canonical FDM grid certificate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wprowadzić jeden walidowany `FdmGridCertificateIR` obejmujący geometry-to-grid realization i koszt.

**Architecture:** Certificate powstaje po walidacji gridu i jest częścią planu/provenance. Runner nie przelicza jego pól; sprawdza fingerprint przed użyciem.

**Tech Stack:** Rust IR/planner/artifacts, serde, capability matrix

## Global Constraints

- Certificate opisuje fakty resolved, nie zastępuje requested intent.
- `L_i = N_i d_i`; origin i topology/grid hash są obowiązkowe.
- Nie tworzyć konkurencyjnego PBC certificate; PBC rozszerza identity tego gridu.

---

**Finding:** MESH-FDM-007, P1.
**Dependencies:** MESH-FDM-001 i MESH-FDM-005.

### Task 1: publication/contract

- [ ] Zaktualizować `docs/physics/0100-mesh-and-region-discretization.md` oraz dla okresów `docs/physics/0600-periodic-boundary-conditions.md` o pola, jednostki i kryteria certyfikatu.
- [ ] Dodać RED serde/validation tests w `crates/fullmag-ir/src/plan.rs` dla złego `N*d`, hash i active count.

### Task 2: implementacja

```rust
pub struct FdmGridCertificateIR {
    pub origin_m: [f64; 3], pub counts: [u32; 3], pub cell_m: [f64; 3],
    pub extent_m: [f64; 3], pub active_cells: u64, pub estimated_bytes: u64,
    pub grid_fingerprint: String,
}
```

- [ ] Utworzyć typ w `crates/fullmag-ir/src/plan.rs`, materializować go w `crates/fullmag-plan/src/fdm.rs` i publikować w `crates/fullmag-runner/src/fdm/artifacts.rs`.
- [ ] Dodać fail-closed runner assertion dla fingerprint/counts.
- [ ] Uruchomić `cargo test -p fullmag-ir plan --no-fail-fast`, `cargo test -p fullmag-plan fdm --no-fail-fast`, `cargo test -p fullmag-runner fdm --no-fail-fast`; wynik PASS.

### Task 3: commit

- [ ] Commit: `git add docs/physics/0100-mesh-and-region-discretization.md docs/physics/0600-periodic-boundary-conditions.md crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner && git commit -m "feat(fdm): certify resolved grid realization"`.

**Exit:** każdy plan FDM zawiera zweryfikowany certificate, a artifacts pozwalają odtworzyć `origin`, `N`, `d`, `L`, active count, budget i fingerprint.

## Evidence update (2026-07-14)

- [x] Physics contract is documented in `docs/physics/0100-mesh-and-region-discretization.md` and `docs/physics/0600-periodic-boundary-conditions.md`, including SI units, `N*d` extent identity, active-cell count, memory estimate and fingerprint semantics.
- [x] `FdmGridCertificateIR` is materialized by single-grid and multilayer planner paths, serialized as `mesh/fdm_grid_certificate.json`, and consumed by runner pre-allocation guards; the runner validates counts, extent, active mask, memory estimate and fingerprint before allocation.
- [x] RED/GREEN certificate tests: `cargo test -p fullmag-ir fdm_grid_certificate --lib --no-fail-fast` — 5 passed; `cargo test -p fullmag-plan fdm --lib --no-fail-fast` — 43 passed; `cargo test -p fullmag-runner fdm::tests --lib --no-fail-fast` — 5 passed.
- [x] Realized FDM region membership is published through the binary data-plane artifacts with a stable numeric legend and the same grid/legend fingerprints; no thin JSON payload carries the cell mask.
- [ ] Managed CPU/CUDA runtime evidence and full cross-backend parity gates remain open and are tracked by MESH-GATE-001..004.
