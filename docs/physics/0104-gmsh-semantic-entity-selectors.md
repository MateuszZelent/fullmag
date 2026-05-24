# Gmsh semantic entity selectors for FEM mesh controls

- Status: draft
- Owners: Fullmag maintainers
- Last updated: 2026-05-24
- Related ADRs: docs/adr/0011-resource-first-api.md
- Related specs: docs/superpowers/specs/2026-05-24-gmsh-semantic-entity-selectors-design.md

## 1. Problem statement

Fullmag FEM mesh controls can already refine component volumes, component
surfaces, recovered boundary curves, and explicit surface or curve tag lists.
The weak point is that raw Gmsh entity tags are implementation artifacts:
boolean operations, fragmentation, airbox assembly, CAD import, and Gmsh version
changes can alter tags without changing the physical object.

This note defines a discretization-only selector layer for FEM meshing. Users
and higher-level Fullmag code describe a target surface or curve by stable
semantic intent, such as the nearest entity to a physical point, while the Gmsh
adapter resolves that intent to concrete entity tags after geometry realization.

This is not a new energy term, material model, boundary condition, or observable.
It is a reproducible way to target existing FEM mesh-size and boundary-layer
controls.

## 2. Physical model

### 2.1 Governing equations

No governing micromagnetic equation changes. The continuous problem remains the
same Landau-Lifshitz-Gilbert problem and associated effective-field terms
defined by the active study.

The selector affects only the spatial discretization map:

```text
Omega -> T_h(Omega)
```

where `Omega` is the physical FEM domain and `T_h(Omega)` is the conforming
solver mesh. A selector changes local mesh-size constraints or boundary-layer
targets used to construct `T_h`; it must not change `Omega`, material regions,
airbox semantics, or solver boundary conditions.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
| --- | --- | --- |
| `p = (x, y, z)` | physical selector point | m |
| `n` | maximum number of matched entities | dimensionless |
| `d(p, E)` | Euclidean distance from selector point to entity `E` | m |
| `h_min` | requested local minimum element size | m |
| `h_max` | requested local maximum element size | m |
| `T_h` | realized finite-element mesh | m-coordinate topology |

All selector coordinates entering public Fullmag surfaces are SI metres. The
Gmsh adapter may internally scale geometry for numerical robustness, but it must
scale selector coordinates by the same factor before resolving entities.

### 2.3 Assumptions and approximations

- Selectors are resolved after Gmsh geometry construction and after OCC
  boolean/fragment operations that determine final entities.
- `nearest_surface_to_point` and `nearest_curve_to_point` are geometric
  selectors. They do not infer physics from material values.
- If multiple entities are nearly equidistant, resolution is deterministic only
  after sorting by distance and tag. The resolved tag list must be recorded in
  mesh provenance.
- Selectors that cannot resolve any entity fail clearly by default. Silent
  broadening to the whole component is not allowed.

## 3. Numerical interpretation

### 3.1 FDM

None. FDM meshes are regular grids and do not have Gmsh OCC entity tags. This
feature has no FDM discretization meaning.

### 3.2 FEM

For FEM, semantic selectors lower to concrete Gmsh entity tags:

- `nearest_surface_to_point` resolves to one or more final surface tags.
- `nearest_curve_to_point` resolves to one or more final curve tags.
- component-scoped selectors restrict candidates to the selected component's
  recovered surfaces or boundary curves.
- unscoped selectors may use all final OCC entities of the requested dimension.

The resolved tags are then consumed by existing mechanisms:

- boundary layers use `boundary_layer_target_surface_tags` and
  `boundary_layer_target_curve_tags`;
- edge-local fields use `EdgeDistanceThreshold`;
- surface shell fields use `SurfaceDistanceThreshold`;
- component bulk fields remain unchanged.

The active element size at any point remains the minimum/maximum composition of
the existing Gmsh background fields and global mesh-size bounds.

### 3.3 Hybrid

Hybrid FDM/FEM remains future work. Selectors apply only to the FEM part of a
future hybrid domain.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The first implementation should keep public Python additions narrow. The
preferred public shape is a structured mesh selector dictionary or helper in
`fm.mesh`, not raw Gmsh calls. Example intent:

```python
fm.mesh.boundary_layers(
    count=3,
    first_layer_thickness=1e-9,
    target_surfaces=[
        fm.mesh.nearest_surface_to_point(
            geometry="free_layer",
            point=(50e-9, 0.0, 2.5e-9),
        )
    ],
)
```

Existing explicit tag lists remain supported for debugging and advanced import
workflows, but semantic selectors are the preferred reproducible surface.

### 4.2 ProblemIR representation

ProblemIR must preserve requested selector intent separately from resolved Gmsh
tags. Resolved tags belong in realized mesh build artifacts and provenance, not
in canonical physical problem intent.

Required distinction:

- requested intent: selector kind, component name, point, dimension, count;
- resolved realization: Gmsh version, candidate scope, resolved tags, distances,
  fallback or failure reason.

### 4.3 Planner and capability-matrix impact

The planner must treat semantic Gmsh selectors as a FEM meshing capability. A
backend that does not use Gmsh may reject them or lower them through an
equivalent selector implementation only if it can preserve the same requested
intent and provenance contract.

The capability should be separate from solver execution capability. Mesh
generation can support semantic selectors even when a native solver backend is
unavailable.

## 5. Runtime, artifacts, and workspace impact

Mesh build reports should include:

- requested selector objects;
- resolved entity tags;
- candidate scope;
- distance values in metres;
- Gmsh version;
- orphan-entity diagnostics when available.

The control-room UI can initially display this only in diagnostics or mesh build
details. No viewport authoring UI is required for the first implementation.

OpenAPI impact is limited to mesh-build artifact/report schemas if those reports
are exposed through v2 resources. Heavy mesh topology transport is unchanged.

## 6. Validation strategy

### 6.1 Analytical checks

Use simple boxes with known face centers. A selector point near the positive-x
face should resolve a surface whose bounding box lies at the positive-x extent.

### 6.2 Cross-backend checks

No FDM cross-check is required. FEM CPU/GPU solver parity is unaffected because
the selector only changes mesh generation.

### 6.3 Regression tests

- Unit-test selector normalization and validation.
- Use a real `gmsh 4.15.x` test for nearest surface resolution on a box.
- Use a real `gmsh 4.15.x` test for nearest curve resolution on a box or
  arch-waveguide CSG path.
- Verify that unresolved selectors fail with a specific error.
- Verify that mesh build reports include requested selector and resolved tag
  provenance.
- Verify that explicit tag-list workflows remain unchanged.

## 7. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend marked not applicable
- [ ] FEM mesh adapter
- [ ] Runtime mesh build report
- [ ] OpenAPI/resource artifact review
- [ ] Tests / benchmarks
- [ ] Documentation

## 8. Known limits and deferred work

- No automatic UI picking in the first implementation.
- No fuzzy semantic names such as "top", "bottom", or "left" until the object
  frame and transformation semantics are specified.
- No selector support for non-Gmsh backends until they can report equivalent
  resolved provenance.
- No automatic repair of invalid CAD; orphan diagnostics report issues but do
  not heal geometry.

## 9. References

- Gmsh 4.15.2 reference manual: https://gmsh.info/doc/texinfo/
- Gmsh 4.15.0 version history: changed `getBoundary` default orientation,
  added closest-entity APIs, and improved `Constant` / `Restrict` mesh-size
  fields.
