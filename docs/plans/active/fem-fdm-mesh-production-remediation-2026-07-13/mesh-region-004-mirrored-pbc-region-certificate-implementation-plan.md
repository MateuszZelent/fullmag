# MESH-REGION-004 — Mirrored PBC region certificate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PBC FEM jest legalne tylko wtedy, gdy lustrzane/translacyjne pary seam zachowują region membership i realizowane pola materiałowe.

**Architecture:** `periodic_mesh_certificate.v6` zostaje rozszerzony, a nie zastąpiony. Post-extraction validator paruje elementy/ściany i porównuje owner/region class oraz nodal i DG0 material values; certificate jest związany z mesh generation, topology hash, marker map i material realization hash.

**Tech Stack:** Physics note, ProblemIR/certificate, Gmsh, Rust planner, MFEM CPU/GPU

## Global Constraints

- Porównanie używa jawnej translacji i opublikowanych tolerancji SI.
- Wieloosiowe PBC obejmuje face, edge i corner equivalence classes.
- Mismatch region/material blokuje static, time-domain i frequency-domain run.

---

**Finding:** MESH-REGION-004, P0.
**Dependencies:** MESH-PBC-FEM-002/004/005/006, MESH-REGION-006.

### Task 1: publikacja fizyki i fixtures RED

- [x] Uzupełnić `docs/physics/0600-periodic-boundary-conditions.md` o warunek `region(x)=region(x+L)` oraz tolerancje dla nodal i DG0 `Ms`, `A`, `alpha` i innych coefficient fields.
- [ ] Dodać mirrored fixture PASS oraz kontrolowane mismatches: region ID, marker owner, DG0 Ms/A, edge/corner class; uruchomić generator/planner/native contract tests i potwierdzić RED.

### Task 2: certificate i legality

```rust
struct PeriodicRegionMaterialCertificate {
    topology_hash: String,
    marker_map_hash: String,
    material_realization_hash: String,
    class_count: u64,
    max_material_residual: f64,
}
```

- [x] Rozszerzyć canonical v6 schema/IR/provenance o marker/material realization fingerprints, class count, residual i stable failure reasons; nie tworzyć równoległego certyfikatu.
- [x] Po extraction certyfikować paired face elements i DG0 `Ms`/`A` arrays; planner wymaga materiałowego certyfikatu dla każdej okresowej osi, gdy pola DG0 są zrealizowane.
- [x] Native FEM rewaliduje certyfikat przed alokacją backendu i odrzuca seam mismatch przed assembly.

### Task 3: managed proof

- [ ] Uruchomić schema/OpenAPI tests, planner tests i container-backed FEM CPU/GPU periodic gates; PASS dla mirrored i fail-closed dla każdego mismatch.
- [ ] Zapisać certificate artifact i Inspector-ready reason details; uaktualnić M5 evidence matrix.
- [ ] Commit: `git add docs/physics/0600-periodic-boundary-conditions.md packages/fullmag-py crates/fullmag-ir crates/fullmag-plan backends/fem justfile && git commit -m "fix(pbc): certify mirrored region materials"`.

**Exit:** żadna okresowa realizacja FEM nie przechodzi z niesymetryczną klasą regionu lub materiału na seam.

### Evidence (2026-07-14, partial mirrored material lane)

- Physics note now defines `region(x)=region(x+L)`, owner identity, face/edge/corner constraints, SI units and DG0/nodal tolerance semantics.
- `PeriodicMeshCertificateV6IR` now carries marker-map and material-realization fingerprints, region-class count and normalized seam material residual.
- `MeshIR::periodic_mesh_certificate_v6_with_material_fields` compares paired adjacent elements by marker and rejects mismatched DG0 `Ms`/`A` values with stable reason text.
- Planner invokes the material-aware certificate after conformal element fields are realized; runner persists the fingerprints in `periodic_pairs.v1.json` and revalidates immediately before native allocation.
- Planner now binds the marker-map fingerprint to the canonical serialized `ProblemIR.object_regions` owner/region declarations; a controlled owner/region rename produces a different certificate identity (`periodic_certificate_binds_authored_region_identity`, 1/1).
- `cargo test -p fullmag-ir --lib --no-fail-fast` — 30 passed; focused mirrored material mismatch/acceptance tests — 2 passed; periodic planner and runner artifact tests pass.
- Nodal-P1 `Ms`/`A` seam comparison is now part of the same v6 certificate path; controlled nodal mismatch and equal-value fixtures pass in `fullmag-ir` (40/40 total library tests).
- Planner and runner artifact/native revalidation pass nodal `material.ms_field`/`material.a_field` through the certificate instead of checking only DG0 coefficients; `cargo test -p fullmag-plan --lib --no-fail-fast` — 215 passed; `cargo check -p fullmag-runner` — pass with one pre-existing dead-code warning.
- Remaining open: persisted certificate comparison against an independent build generation, managed CPU/GPU mirrored gates and M5 primitive/supercell evidence. MESH-REGION-004 remains open.

### Evidence update (2026-07-14, API persisted marker identity guard)

- [x] The API now rejects an accepted `periodic_pairs.v1.json` artifact when
  its persisted v6 schema/status/topology/marker-map identity does not match
  the current live mesh. It falls back to the authoritative live resource
  instead of exposing a same-topology artifact with a forged marker map.
- [x] RED/GREEN regression:
  `cargo test -p fullmag-api mesh_periodic_pairs_rejects_artifact_with_mismatched_marker_certificate`
  — RED before the guard, then 1 passed; adjacent
  `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast -- --nocapture`
  — 11 passed.
- [ ] Full material-value comparison still belongs to planner/runner because
  the thin live `FemMeshPayload` does not carry realized coefficient arrays;
  managed CPU/GPU mirrored gates and M5 primitive/supercell evidence remain
  open.
