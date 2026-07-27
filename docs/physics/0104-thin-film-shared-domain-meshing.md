# Thin-film shared-domain meshing

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-07-27
- Related notes:
  - `docs/physics/0102-airbox-mesh-grading-geometric.md`
  - `docs/physics/0103-rectangular-waveguide-edge-corner-mesh-refinement.md`
  - `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`

Production-readiness criteria for thin-film FEM meshing are defined in
`docs/physics/0105-fem-meshing-production-acceptance.md`.

## 1. Problem statement

Thin magnetic films combine a nanometre-scale thickness with lateral dimensions
that can be hundreds or thousands of nanometres. A free tetrahedral mesh of the
whole magnetic body plus Poisson airbox can either over-refine the air volume or
produce poor airbox tetrahedra near the film because the interface surface scale
and the far-field airbox scale differ by orders of magnitude.

The public mesh API needs a thin-film method that says: keep the magnetic film
resolved through thickness, refine air only near physically sensitive surfaces,
edges, and endpoints, and grow back to the far-field airbox target without
letting one global transition distance refine the whole air volume.

## 2. Physical model

### 2.1 Governing equations

This method does not change the micromagnetic equations. It changes the FEM
spatial discretization used for the same weak forms:

- exchange and local terms are evaluated on the magnetic subdomain,
- Poisson-airbox demagnetics are evaluated on the conforming magnetic+air
  shared domain,
- the magnetic-air interface remains conforming.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `t` | magnetic film thickness | m |
| `h_body` | magnetic body maximum element size | m |
| `h_min` | requested minimum/through-thickness size | m |
| `h_surf` | near-interface air target size | m |
| `d_surf` | distance over which surface sizing is held/ramped | m |
| `h_edge` | edge plume target size | m |
| `d_edge` | edge plume thickness/transition distance | m |
| `h_corner` | endpoint/corner plume target size | m |
| `d_corner` | endpoint/corner extent/transition distance | m |

### 2.3 Assumptions and approximations

- The method is intended for high-aspect-ratio films where one dimension is much
  smaller than the lateral dimensions.
- In the current shared-domain OCC implementation the realization remains
  tetrahedral. The method is a feature-aware thin-film tetrahedral preset, not a
  swept-prism airbox implementation.
- The canonical future native mixed-P1 realization is specified in note 0106.
  It preserves the same public intent but remains non-executable until its
  topology, operator, transport, and managed-runtime gates pass.

## 3. Numerical interpretation

### 3.1 FDM

No FDM semantics change. FDM thin-film resolution remains controlled by the
regular grid cell size.

### 3.2 FEM

For FEM, `body.mesh.thin_film(...)` lowers to existing mesh controls:

- body `maximum_element_size` and `minimum_element_size`,
- `mesh_strategy="thin_film_tetrahedral"` for provenance,
- through-thickness layer intent,
- COMSOL-like `curvature_factor` and `narrow_region_resolution` intent through
  the same canonical controls as `body.mesh(...)`,
- interface/surface transition sizing,
- edge and corner distance fields with independent transition spans.
- rectangular flat-arch edge/corner bands in the magnetic body, so a flat
  `ArchWaveguide` uses the same deterministic in-plane edge/corner policy as a
  `Box` instead of relying only on recovered CAD curve endpoints.
- airbox rectangular-envelope grading from the object bounds to the explicit
  airbox bounds, so diagonal/corner air regions do not become an uncontrolled
  far-field plateau after the near-interface halo.

The final solver mesh remains one conforming shared-domain mesh.

### 3.3 Hybrid

No hybrid backend behavior is introduced.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Add `body.mesh.thin_film(...)` as a convenience method for thin films. The method
does not create a second mesh model; it fills the canonical mesh metadata used by
`body.mesh(...)`.

### 4.2 ProblemIR representation

The lowered representation remains `runtime_metadata.mesh_workflow`. The new
method records `mesh_strategy="thin_film_tetrahedral"` plus the resolved
surface, edge, corner, and through-thickness controls.

### 4.3 Planner and capability-matrix impact

No new solver capability is required. Runtime provenance should report the
requested thin-film method and the realized tetrahedral method.

## 5. Validation strategy

### 5.1 Analytical checks

Pure-data tests should verify that thin-film API calls emit independent surface,
edge, and corner sizing fields and do not reintroduce global transition
inheritance for corners.

### 5.2 Cross-backend checks

No FDM cross-check is required for this API addition. Solver accuracy checks for
Poisson-airbox demag remain deferred to the airbox validation program.

### 5.3 Regression tests

- Python DSL metadata/round-trip test for `body.mesh.thin_film(...)`.
- Size-field planning test for generated thin-film surface/edge/corner fields.
- Real `arch_waveguide_relax_50nm.py` materialization smoke test.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR metadata
- [x] Planner/provenance metadata
- [ ] Capability matrix
- [ ] FDM backend
- [x] FEM tetrahedral realization
- [ ] Swept/layered airbox realization
- [x] Tests / smoke checks
- [x] Documentation

## 7. Known limits and deferred work

- The first implementation is a feature-aware tetrahedral preset.
- Native prism/pyramid/tet shared-domain execution is deferred under note 0106;
  the checked-in Gmsh fixture proves topology feasibility only.
- Very flat airboxes can still produce low-quality tetrahedra in isolated
  regions; the method reduces uncontrolled refinement but does not replace all
  geometry-quality work.

## 8. References

- Gmsh mesh size fields and OCC fragmentation.
- COMSOL swept meshing and boundary layer terminology.
