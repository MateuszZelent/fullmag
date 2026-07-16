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

- [x] Utworzyć typ w `crates/fullmag-ir/src/mesh_hints.rs` oraz strict planner validation w `crates/fullmag-plan/src/fem.rs` (slice obejmuje node/face bijection, translated vertices, area/orientation, normals, marker coverage i topology fingerprint).
- [ ] Dokończyć generator w Python periodic meshing oraz walidację domen/FE-space ownership w `mesh.rs`.
- [ ] Native `mesh_symmetry_certificate` ma konsumować tę samą treść, nie tworzyć alternatywnej definicji.
- [ ] Uruchomić periodic Python, IR i planner tests oraz managed native contract; corrupt fixtures FAIL-closed, valid fixtures PASS.

### Evidence (2026-07-14, partial)

- `cargo test -p fullmag-ir mesh_validation_tests::periodic_certificate_v6 --lib` — 4 passed (w tym brak pokrycia boundary-face przez node bijection).
- v6 axis evidence zawiera teraz certyfikowane globalne face IDs, explicit vertex bijections, area/translation residuals i rzeczywiste normal dots; `corner_edge_cycle_unique` jest wyliczane przez fail-closed validator z testem kolizji/closure.
- `cargo test -p fullmag-plan --lib fem_static_time_domain_plans_exchange_only_periodic_mesh_pairs` — passed; accepted certificate identity is copied into planner provenance.
- v6 now also carries `marker_map_fingerprint`, `material_realization_fingerprint`, `region_class_count` and `max_material_residual`; planner and native runner use the material-aware validation lane when DG0 fields are present.
- Planner binds the marker-map fingerprint to serialized `ProblemIR.object_regions` owner/region identity via `periodic_certificate_with_region_identity`; controlled identity-change test passes 1/1.
- `cargo test -p fullmag-ir --lib --no-fail-fast` — 30 passed; focused mirrored DG0 mismatch/acceptance tests — 2 passed.
- Native managed contract, Python generator, separate magnetic/scalar FE class hashes, owner/material realization hash and pełne explicit edge/corner fixtures remain open.

### Evidence update (2026-07-14, Python certificate retention)

- [x] Gmsh extraction now performs the strict post-extraction v6 check and retains the accepted certificate in `MeshData.periodic_mesh_certificate` rather than discarding the result.
- [x] The certificate survives `MeshData.oriented_copy()`, JSON/NPZ serialization and `MeshData.to_ir`; remesh responses and spilled topology artifacts include the same certificate payload.
- [x] RED/GREEN evidence: `test_certify_extracted_periodic_mesh_rejects_missing_mirrored_face` failed before the field existed and now passes; full Python meshing suite — 246 passed, 1 skipped.
- [ ] Rust `MeshIR`/planner provenance, native contract and managed/browser evidence still need to consume and independently revalidate this retained evidence; MESH-PBC-FEM-002 remains open.
- [x] JSON and NPZ mesh reload regression preserves the accepted certificate (`test_certify_extracted_periodic_mesh_rejects_missing_mirrored_face` remains GREEN after both round-trips).

### Task 3: commit

- [ ] Commit: `git add docs/physics docs/adr/0012-canonicalization-backbone.md packages/fullmag-py crates/fullmag-ir crates/fullmag-plan backends/fem && git commit -m "feat(mesh): enforce periodic mesh certificate v6"`.

**Exit:** solver nie uruchamia PBC bez v6 powiązanego z bieżącym topology hash; wszystkie corrupt fixtures są odrzucone z konkretnym reason.
