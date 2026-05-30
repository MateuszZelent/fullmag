# FEM meshing production acceptance

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-05-30
- Related ADRs: `docs/adr/0009-geometry-invalidates-mesh.md`, `docs/adr/0010-magnetization-does-not-invalidate-mesh.md`
- Related specs: `docs/specs/mesh-roundtrip-semantics-v1.md`, `docs/specs/resource-first-control-room-api-v2.md`
- Related notes:
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/0102-airbox-mesh-grading-geometric.md`
  - `docs/physics/0103-rectangular-waveguide-edge-corner-mesh-refinement.md`
  - `docs/physics/0104-thin-film-shared-domain-meshing.md`
  - `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`

## 1. Problem statement

Fullmag FEM meshing is production-ready only when the requested physical mesh
intent, the realized shared-domain mesh, and the user-visible diagnostics agree
for the declared support matrix.

The production claim is deliberately scoped. It covers the workflows listed in
Section 5, not arbitrary invalid CAD, arbitrary anisotropic size fields,
non-manifold imported surfaces, or unbounded recovery from every Gmsh failure.

## 2. Physical model

### 2.1 Governing equations

Meshing does not introduce a new micromagnetic energy term. It defines the
spatial discretization on which existing FEM weak forms are evaluated.

For Poisson-airbox demagnetics the computational domain is:

```text
Omega_shared = Omega_magnetic union Omega_air
```

The magnetic-air interface is conforming:

```text
Gamma_interface = boundary(Omega_magnetic) intersect boundary(Omega_air)
```

The outer airbox boundary is:

```text
Gamma_out = boundary(Omega_air) \ Gamma_interface
```

The air scalar potential satisfies the air-domain Laplace equation used by the
existing FEM demag notes:

```text
div(grad(phi)) = 0 in Omega_air
```

The magnetic subdomain carries magnetization and material coefficients. The air
subdomain carries demag potential and external-field quantities only. Vector
fields such as magnetization `m` are undefined in air and must not be rendered
or sampled as if airbox nodes belonged to magnetic objects.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `h_obj` | per-object bulk target size | m |
| `h_if` | interface/near-surface target size | m |
| `h_air_min` | near-object airbox target size | m |
| `h_air_max` | far-field airbox target size | m |
| `g_air` | airbox geometric grading shape parameter | dimensionless |
| `d_surface` | surface transition distance | m |
| `h_edge` | boundary-curve target size | m |
| `d_edge_hold` | edge plume hold distance | m |
| `d_edge_transition` | edge plume transition span | m |
| `h_corner` | endpoint/corner target size | m |
| `d_corner_hold` | corner hold distance | m |
| `d_corner_transition` | corner transition span | m |
| `q_sicn` | signed inverse condition number quality metric | dimensionless |
| `q_gamma` | gamma or gamma-like quality metric | dimensionless |

### 2.3 Assumptions and approximations

- The production shared-domain mesh is tetrahedral unless a workflow explicitly
  declares a swept/layered strategy and reports the realized strategy.
- The mesh is one conforming solver mesh. Region statistics may overlap in node
  sets at shared interfaces, but element ownership must remain unambiguous.
- Airbox far-field elements may be much larger than magnetic body elements, but
  airbox fields must not coarsen object-air interface triangulation.
- `airbox_growth_rate` and `transition_growth` shape the target-size curve.
  They are not production proof by themselves; realized element-size growth is
  accepted only through distance-band diagnostics.
- Production support requires truthful degradation reports. A fallback path that
  skips edge/corner fields is allowed only when the report marks the skipped
  fields and names the missing component topology.

## 3. Numerical interpretation

### 3.1 FDM

No FDM discretization behavior is introduced by this acceptance note. FDM uses
regular grid cells and active masks. FDM may share geometry intent with FEM, but
the production readiness criteria here apply to FEM shared-domain meshing only.

### 3.2 FEM

FEM production meshing must satisfy these contracts:

1. **Shared-domain conformance**
   - magnetic and air volumes share the same interface vertices and faces,
   - final solver elements have stable volume markers,
   - `Gamma_interface` and `Gamma_out` have stable boundary markers.

2. **Object priority**
   - at `Gamma_interface`, the effective target size is no coarser than the
     relevant per-object surface/interface target,
   - coarse `h_air_min` or `h_air_max` never clamps object boundary sizing.

3. **Airbox adaptation**
   - airbox surface-distance, edge-distance, corner-distance, and envelope
     fields refine near magnetic features and grow toward `h_air_max`,
   - rectangular airboxes control diagonal and corner regions, not only
     axis-normal directions,
   - spherical airboxes either use radial grading or are not included in the
     production support matrix.

4. **Thin-film adequacy**
   - through-thickness intent is preserved in metadata and provenance,
   - surface, edge, and corner refinement spans are independent,
   - the default interactive examples stay below declared node/tetra/RAM
     budgets or are not labeled interactive defaults.

5. **Quality truthfulness**
   - Gmsh SICN is reported as SICN only when computed as SICN,
   - swept or topology-proxy quality metrics are labeled as proxy metrics,
   - per-domain quality and histograms use final shared-domain markers.

### 3.3 Hybrid

Hybrid execution is out of scope for this production gate. A future hybrid gate
must add projection semantics between FEM tetrahedra and auxiliary Cartesian
grids before it can reuse this production claim.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The public Python mesh surface remains physics-first:

- `study.universe.mesh(...)` describes airbox/far-field mesh policy,
- `body.mesh(...)` describes per-object mesh policy,
- `body.mesh.thin_film(...)` is a convenience lowering to canonical per-object
  mesh metadata,
- edge/corner controls are per-object feature controls, not global airbox
  controls,
- visibility/isolation controls in the browser do not alter physics.

Any production-supported public mesh option must round-trip through Python
export. Options that are not realized by a backend must fail validation or
appear in provenance as degraded/ignored.

### 4.2 ProblemIR representation

Production mesh intent lowers through `runtime_metadata.mesh_workflow`.
`ProblemIR.geometry_assets` may carry the realized mesh, but the mesh asset is
not the canonical authoring model. The canonical authoring model remains the DSL
and the lowered mesh workflow.

The realized mesh report must preserve:

- requested airbox target,
- requested per-object targets,
- realized size-field kinds,
- realized operation statuses,
- fallback/degradation reasons,
- scoped mesh statistics and quality.

### 4.3 Planner and capability-matrix impact

Planner/capability reporting must distinguish:

- supported production path,
- supported degraded path,
- unsupported path,
- failed path.

The capability matrix must not treat a silently skipped size field as a
successful production realization. Skipped component-aware edge/corner fields in
concatenated STL fallback are degraded, not production-equivalent.

## 5. Production support matrix

| ID | Geometry / workflow | Airbox | Required result |
|---|---|---|---|
| S1 | `fm.Box` thin film, one magnetic object | bbox | air-side surface, edge, and corner refinement all active; object and airbox statistics separate |
| S2 | flat `fm.ArchWaveguide(arch_height=0)` | bbox | lowered as box-like geometry; thin-film preset preserves one-through-thickness layer intent and stable air grading |
| S3 | curved `fm.ArchWaveguide(arch_height>0)` | bbox | non-box surface/edge/corner distance fields are geometric and realized without body-only restriction |
| S4 | `fm.Cylinder` | bbox | curved sidewall and top/bottom edges produce smooth air-side gradient and no object-boundary coarsening |
| S5 | multi-object box + cylinder | bbox | per-object targets do not overwrite each other; airbox adapts to the finest local object/interface target |
| S6 | imported STL component-aware path | bbox | fallback reports realized/degraded operations without secondary planner exceptions |
| S7 | imported STL concatenated fallback | bbox | unsupported component-only fields are approximated by bounds fields or explicitly degraded in report |
| S8 | bbox airbox with very coarse `airbox_hmax` and small object `hmax` | bbox | interface p95 respects object target; far field approaches airbox target without uncontrolled empty corner regions |
| S9 | spherical airbox | sphere | radial grading is implemented and tested, or sphere is excluded from the production claim |
| S10 | swept/thin-film strategy | bbox | quality metrics are truthful; SICN is real or unavailable, never a mislabeled proxy |
| S11 | control-room mesh diagnostics | bbox | user can read scoped points/nodes/tetrahedra, size histogram, quality histogram, and selected histogram-bin elements |
| S12 | `examples/arch_waveguide_relax_50nm.py` | bbox | materializes without fallback crash, without silent auto-coarsen for intended interactive preset, and with bounded node/RAM estimate |

## 6. Required observables

Every production mesh must make these observables available in logs, mesh IR,
API resources, or UI diagnostics:

- requested mesh controls,
- realized mesh controls,
- total node, element, and boundary-face counts,
- per-part node, element, and boundary-face counts,
- magnetic-air interface face counts,
- outer airbox boundary face counts,
- characteristic-size histogram with at least 30 bins,
- edge-length histogram with at least 30 bins,
- quality histogram with metric provenance,
- worst-element samples for quality metrics,
- histogram-bin element/node indices for UI highlighting,
- degraded operation statuses.

## 7. Validation strategy

### 7.1 Analytical checks

- Pure size-field planner tests prove that each public mesh control produces the
  expected canonical field descriptor.
- Fake-Gmsh tests prove that descriptors lower to the expected Gmsh field kinds
  without component-volume restriction when air-side refinement is intended.
- Mesh statistics unit tests prove per-marker boundary-face and interface-face
  counts are computed from final topology.

### 7.2 Realized mesh checks

Small realized Gmsh fixtures must verify:

- object interface p95 does not exceed the requested object/interface target by
  more than the documented tolerance,
- airbox near/mid/far/corner distance bands are populated,
- airbox characteristic-size p95 grows monotonically away from object features
  within the documented tolerance,
- edge and corner plumes refine air-side tetrahedra near object perimeter
  features,
- fallback reports degradation without replacing the primary failure with a
  secondary planner error.

### 7.3 Cross-layer checks

- Python DSL to ProblemIR to script export preserves mesh controls.
- API v2 exposes the same scoped counts and histograms as `MeshIR`.
- Control-room panels read mesh diagnostics through typed API resources.
- Viewport overlays can highlight selected histogram-bin tetrahedra without
  continuous rendering.

### 7.4 Release gate

Production readiness requires this command to pass:

```bash
just verify-fem-meshing-production
```

The command must run Python meshing tests, Python API tests, Rust API tests,
frontend OpenAPI generation, frontend lint/typecheck/tests, viewport smoke for
mesh visualization, and `git diff --check`.

## 8. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend not applicable and explicitly scoped out
- [ ] FEM backend
- [ ] Hybrid backend not applicable and explicitly scoped out
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [ ] Documentation
- [ ] Production readiness report

## 9. Known limits and deferred work

- Arbitrary invalid CAD repair is not included.
- Non-manifold imported surfaces are not included.
- Arbitrary anisotropic user-defined size fields are not included.
- Hybrid FEM/FDM projection is not included.
- Production support applies only to the support matrix rows marked `passed` in
  the final production readiness report.

## 10. References

- Gmsh mesh size fields and OCC fragmentation.
- `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
- `docs/plans/active/fem-meshing-production-readiness-plan-2026-05-30.md`
