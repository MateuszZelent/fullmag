# MESH-PBC-FEM-002 — Periodic mesh certificate v6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Egzekwować przed solverem istniejący docelowy `periodic_mesh_certificate.v6` dla lustrzanych ścian PBC.

**Architecture:** Mesher generuje evidence, IR waliduje strukturę, planner rozstrzyga legality, native runtime sprawdza fingerprint. Nie powstaje drugi słownik certyfikatu.

**Tech Stack:** Python/Gmsh, Rust IR/planner, C++ FEM, ADR

## Global Constraints

- Implementować kontrakt z `docs/plans/active/fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md`.
- Certyfikat obejmuje node/face bijection, translated vertices, area, orientation, real normals, domain coverage, corner closure i topology fingerprint.
- Brak lub niepoprawny certificate jest błędem przed solverem.

---

**Finding:** MESH-PBC-FEM-002, P0.

### Task 1: decyzja i RED fixtures

- [ ] Zaktualizować `docs/physics/0600-periodic-boundary-conditions.md`, `0105-fem-meshing-production-acceptance.md` i ADR `0012-canonicalization-backbone.md` o ownership/schema v6.
- [ ] Dodać corrupt fixtures: missing face, duplicated node, mismatched triangulation, flipped orientation, wrong material domain, edge/corner nonclosure; obecny validator ma je błędnie zaakceptować.

### Task 2: cross-layer certificate

```rust
pub struct PeriodicMeshCertificateV6 {
    pub topology_fingerprint: String,
    pub axis_pairs: Vec<PeriodicAxisCertificateV6>,
    pub validation_status: CertificateStatus,
}
```

- [ ] Utworzyć/rozszerzyć typ w `crates/fullmag-ir/src/mesh_hints.rs`; generator w Python periodic meshing; planner validation w `crates/fullmag-plan/src/fem.rs` i `mesh.rs`.
- [ ] Native `mesh_symmetry_certificate` ma konsumować tę samą treść, nie tworzyć alternatywnej definicji.
- [ ] Uruchomić periodic Python, IR i planner tests oraz managed native contract; corrupt fixtures FAIL-closed, valid fixtures PASS.

### Task 3: commit

- [ ] Commit: `git add docs/physics docs/adr/0012-canonicalization-backbone.md packages/fullmag-py crates/fullmag-ir crates/fullmag-plan backends/fem && git commit -m "feat(mesh): enforce periodic mesh certificate v6"`.

**Exit:** solver nie uruchamia PBC bez v6 powiązanego z bieżącym topology hash; wszystkie corrupt fixtures są odrzucone z konkretnym reason.

