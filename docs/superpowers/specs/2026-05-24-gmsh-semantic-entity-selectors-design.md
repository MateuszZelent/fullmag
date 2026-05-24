# Gmsh semantic entity selectors design

- Status: draft
- Date: 2026-05-24
- Scope: `packages/fullmag-py` FEM meshing
- Physics note: `docs/physics/0104-gmsh-semantic-entity-selectors.md`

## 1. Goal

Add a narrow Gmsh 4.15-aware selector layer that lets Fullmag target FEM mesh
surfaces and curves by semantic intent instead of unstable raw Gmsh tags.

The first slice supports:

- nearest OCC surface to a physical point;
- nearest OCC curve to a physical point;
- optional component scoping by Fullmag geometry name;
- resolved-tag provenance in mesh build reports;
- orphan-entity diagnostics after geometry realization.

The first slice does not expose arbitrary Gmsh options, does not change solver
physics, and does not add UI picking.

## 2. Current code context

Relevant files:

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
  defines `MeshOptions` and shared mesh data types.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
  applies size fields and currently consumes explicit component surface/volume
  tags plus explicit boundary-layer tag lists.
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
  creates OCC/GEO geometry, fragments shared domains, and has access to final
  component surface and volume tags.
- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
  lowers Python/runtime mesh controls into `MeshOptions`.
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
  summarizes realized mesh options and should expose selector provenance.
- `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`
  contains public helper wrappers for mesh controls.
- `packages/fullmag-py/tests/test_meshing.py` and
  `packages/fullmag-py/tests/test_meshing_fallbacks.py`
  contain the current meshing contract tests.

The latest dependency bump locks `gmsh 4.15.2`. Local introspection confirms:

```text
gmsh.model.occ.getClosestEntities(x, y, z, dimTags, n=1)
gmsh.model.isEntityOrphan(dim, tag)
gmsh.model.getBoundary(dimTags, combined=True, oriented=False, recursive=False)
```

## 3. Data model

Introduce an internal selector descriptor. Keep it serializable because it must
round-trip through runtime metadata and reports.

```python
{
    "kind": "nearest_surface_to_point",
    "geometry": "free_layer",
    "point": [50e-9, 0.0, 2.5e-9],
    "count": 1,
}
```

Supported kinds:

- `nearest_surface_to_point`
- `nearest_curve_to_point`

Fields:

- `kind`: required string.
- `geometry`: optional Fullmag geometry name. When present, candidates are
  restricted to that component's final surface tags or boundary curve tags.
- `point`: required 3-vector in SI metres.
- `count`: optional positive integer, default `1`.

Resolved selector report:

```python
{
    "kind": "nearest_surface_to_point",
    "geometry": "free_layer",
    "point": [50e-9, 0.0, 2.5e-9],
    "count": 1,
    "candidate_dimension": 2,
    "candidate_tags": [17, 18, 19, 20, 21, 22],
    "resolved_tags": [18],
    "resolved_distances_m": [2.1e-12],
    "status": "resolved",
}
```

Failure report:

```python
{
    "kind": "nearest_surface_to_point",
    "geometry": "missing",
    "point": [0.0, 0.0, 0.0],
    "count": 1,
    "candidate_dimension": 2,
    "candidate_tags": [],
    "resolved_tags": [],
    "resolved_distances_m": [],
    "status": "failed",
    "reason": "no candidate surfaces for geometry 'missing'",
}
```

## 4. Resolution algorithm

Resolution runs after geometry construction and synchronization, before
`_apply_mesh_options()` consumes final tag lists.

For `nearest_surface_to_point`:

1. Determine candidate surfaces.
   - If `geometry` is present, use `component_surface_tags[geometry]`.
   - Otherwise use all `gmsh.model.getEntities(2)` tags.
2. Scale the selector point by the active mesh coordinate scale.
3. Call `gmsh.model.occ.getClosestEntities(x, y, z, candidate_dimtags, n=count)`.
4. Sort the returned entities deterministically by returned order, then tag for
   equal distances if distance data is computed separately.
5. Store resolved surface tags and distance estimates in provenance.

For `nearest_curve_to_point`:

1. Determine candidate curves.
   - If `geometry` is present, derive boundary curves from
     `component_surface_tags[geometry]` using `getBoundary(candidate_surfaces, oriented=False)`.
   - Otherwise use all `gmsh.model.getEntities(1)` tags.
2. Call `occ.getClosestEntities` with curve candidates.
3. Store resolved curve tags and provenance.

Distance values should be computed in SI metres when possible. If Gmsh only
returns entity tags, compute a conservative diagnostic distance from entity
bounding boxes and record `"distance_kind": "bounding_box"`.

## 5. Public API

Add helpers in `fullmag.mesh`:

```python
fm.mesh.nearest_surface_to_point(
    point=(50e-9, 0.0, 2.5e-9),
    geometry="free_layer",
    count=1,
)

fm.mesh.nearest_curve_to_point(
    point=(50e-9, 20e-9, 2.5e-9),
    geometry="free_layer",
    count=1,
)
```

Integrate selectors with existing public controls:

```python
fm.mesh.boundary_layers(
    count=3,
    first_layer_thickness=1e-9,
    target_surfaces=[
        fm.mesh.nearest_surface_to_point(
            point=(50e-9, 0.0, 2.5e-9),
            geometry="free_layer",
        )
    ],
)
```

Existing explicit `target_surface_tags` and `target_curve_tags` stay supported.
When both explicit tags and selectors are provided, both sets are unioned after
selector resolution and the report records both sources.

## 6. Mesh build report and diagnostics

Mesh build reports should include:

- `selector_resolution`: ordered list of resolved selector reports.
- `orphan_entities`: optional list of orphan entity diagnostics.

Orphan diagnostics:

1. After final OCC/GEO synchronization, iterate entities with dimensions 0..3.
2. If `gmsh.model.isEntityOrphan(dim, tag)` exists and returns true, record
   `{ "dim": dim, "tag": tag }`.
3. Do not fail solely because orphan entities exist in the first slice. Report
   them as diagnostics unless a later mesh generation step fails.

## 7. Error handling

Selector validation errors are user errors:

- unknown selector kind;
- missing or malformed point;
- non-positive `count`;
- no candidate entities;
- Gmsh build without `occ.getClosestEntities` when selector resolution is
  requested.

Runtime behavior:

- fail before `gmsh.model.mesh.generate(3)` when a requested selector cannot be
  resolved;
- preserve explicit tag-list workflows unchanged;
- include failure reason in the mesh build report when possible.

## 8. Testing

Required tests:

1. Unit validation of helper output in `mesh_controls.py`.
2. Runtime metadata parsing in `_size_field_plan.py`.
3. Fake-Gmsh unit tests for selector candidate selection.
4. Real-Gmsh box test: nearest point to a known face resolves a surface and
   boundary layers receive that tag.
5. Real-Gmsh curve test: nearest point to a known box edge resolves a curve and
   `EdgeDistanceThreshold` receives that tag.
6. Report test: selector provenance and orphan diagnostics are serialized.
7. Regression test: explicit `boundary_layer_target_surface_tags` still works.
8. Full meshing suite:

```bash
env UV_CACHE_DIR=/tmp/fullmag-uv-cache UV_PYTHON_INSTALL_DIR=/tmp/fullmag-uv-python \
  /tmp/fullmag-uv/bin/uv run --project packages/fullmag-py --all-extras --locked \
  pytest packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_meshing_fallbacks.py -q
```

Expected: all tests pass.

## 9. Deferred work

- UI viewport picking.
- Named orientation selectors such as `top_surface` or `left_edge`.
- Equivalent selectors for non-Gmsh meshing backends.
- Automatic geometry healing based on orphan diagnostics.
