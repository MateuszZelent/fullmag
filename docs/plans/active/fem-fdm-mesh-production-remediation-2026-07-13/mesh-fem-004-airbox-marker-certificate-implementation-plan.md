# MESH-FEM-004 — Certified airbox boundary markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zastąpić heurystykę marker `99`/max marker jawnym certyfikatem roli `Gamma_out`.

**Architecture:** Mesher zapisuje role domen i granic; IR waliduje rozłączność i pokrycie, planner wyłącznie konsumuje certified outer marker.

**Tech Stack:** Python Gmsh extraction, Rust MeshIR/planner, MFEM mesh contract

## Global Constraints

- Marker ID nie koduje roli przez wartość liczbową.
- Magnetic boundary, magnetic-air interface i outer airbox boundary są rozłączne.
- Co najmniej jeden air element oraz kompletne `Gamma_out` są wymagane, gdy airbox jest authored.

---

**Finding:** MESH-FEM-004, P1.
**Files:** `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`, `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`, `crates/fullmag-ir/src/mesh_assets.rs`, `crates/fullmag-plan/src/mesh.rs`, `backends/fem/core/fem_mesh.cpp`, `backends/fem/tests/fem_mesh_contract.cpp`.

### Task 1: RED

- [ ] Dodać fixtures: marker 99 użyty wewnętrznie, outer marker inny niż największy, brak części outer faces i marker współdzielony z interface.
- [ ] Uruchomić Python mesh tests i managed `fem_mesh_contract`; corrupt fixtures mają obecnie przejść lub być źle sklasyfikowane.

### Task 2: GREEN

```rust
pub struct BoundaryRoleIR { pub marker: i32, pub role: BoundaryRole, pub face_count: u64 }
```

- [ ] Generować role z physical groups, walidować pokrycie/rozłączność i usunąć fallback `99`/max.
- [ ] Przekazać certified marker przez native mesh contract; fail-closed, jeśli `Gamma_out` nie istnieje lub jest niejednoznaczne.
- [ ] Uruchomić `just verify-fem-meshing-production` i container-backed native contract; PASS.

### Task 3: commit

- [ ] Commit: `git add packages/fullmag-py crates/fullmag-ir crates/fullmag-plan backends/fem && git commit -m "fix(fem): certify airbox boundary roles"`.

**Exit:** solver nie wybiera markeru po numerze; wszystkie airbox fixtures mają dowód kompletności i rozłączności.

## Evidence update (2026-07-14)

- [x] `MeshIR::certify_airbox_boundary_roles` derives `Gamma_out`, magnetic boundary and magnetic-air interface from tetrahedral adjacency; marker values are opaque and no max/`99` heuristic is used by the planner path.
- [x] The planner consumes the certified `Gamma_out` marker, records `boundary_marker_source` and `airbox_boundary_certificate_sha256`, and fails closed on missing, ambiguous or role-shared markers.
- [x] Corrupt-fixture evidence: `cargo test -p fullmag-ir airbox_roles --lib --no-fail-fast` — 3 passed (non-max marker, incomplete outer faces, marker shared with interface); `cargo test -p fullmag-plan airbox --lib --no-fail-fast` — 7 passed.
- [ ] Python/Gmsh fixture extraction, managed `fem_mesh_contract` and `just verify-fem-meshing-production` remain open because the managed gate is currently blocked by the repository `/etc/bash.bashrc` `PS1` failure.
