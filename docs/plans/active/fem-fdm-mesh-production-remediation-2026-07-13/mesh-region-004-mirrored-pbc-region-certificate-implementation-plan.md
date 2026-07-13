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

- [ ] Uzupełnić `docs/physics/0600-periodic-boundary-conditions.md` o warunek `region(x)=region(x+L)` oraz tolerancje dla nodal i DG0 `Ms`, `A`, `alpha` i innych coefficient fields.
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

- [ ] Rozszerzyć canonical v6 schema/IR/provenance o powyższy dowód i stable failure reasons; nie tworzyć równoległego certyfikatu.
- [ ] Po Gmsh extraction certyfikować paired face elements, region/owner membership, nodal fields i DG0 arrays; planner wymaga fresh certificate dla każdej okresowej osi.
- [ ] Native FEM weryfikuje hashes przed assembly constraints i odrzuca stale/mismatch przed solver allocation.

### Task 3: managed proof

- [ ] Uruchomić schema/OpenAPI tests, planner tests i container-backed FEM CPU/GPU periodic gates; PASS dla mirrored i fail-closed dla każdego mismatch.
- [ ] Zapisać certificate artifact i Inspector-ready reason details; uaktualnić M5 evidence matrix.
- [ ] Commit: `git add docs/physics/0600-periodic-boundary-conditions.md packages/fullmag-py crates/fullmag-ir crates/fullmag-plan backends/fem justfile && git commit -m "fix(pbc): certify mirrored region materials"`.

**Exit:** żadna okresowa realizacja FEM nie przechodzi z niesymetryczną klasą regionu lub materiału na seam.
