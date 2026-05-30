# Mesh Pipeline Audit - 2026-05-30

## Scope

Audit obejmuje aktualny worktree dla FEM/shared-domain meshingu:

- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- mesh statistics path in `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`

Nie jest to review całego UI. UI/API zostały sprawdzone tylko tam, gdzie wpływają na interpretację statystyk meshu.

## Verification Run

Commands run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_meshing.py \
  -k "airbox_grading or edge_threshold or corner_threshold or flat_arch_thin_film_materialization" -vv
```

Result:

```text
9 passed, 154 deselected in 1.04s
```

Additional probes:

```bash
PYTHONPATH=packages/fullmag-py/src python3 - <<'PY'
import fullmag as fm
from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata
geom = fm.ArchWaveguide(length=100e-9, width=40e-9, height=2e-9, arch_height=0.0, name='wg')
try:
    _mesh_options_from_runtime_metadata(
        {'per_geometry':[{'geometry':'wg','edge_hmax':'5e-9','edge_thickness':'5e-9'}]},
        geometries=[geom],
        default_hmax=80e-9,
        component_aware=False,
    )
except Exception as exc:
    print(type(exc).__name__, exc)
PY
```

Result:

```text
ValueError wg: edge/corner refinement currently requires component-aware shared-domain meshing
```

```bash
PYTHONPATH=packages/fullmag-py/src python3 - <<'PY'
import fullmag as fm
from fullmag.meshing._size_field_plan import _build_field_stack
geom = fm.ArchWaveguide(length=100e-9, width=40e-9, height=2e-9, arch_height=0.0, name='wg')
fields = _build_field_stack([geom], default_hmax=500e-9, per_geometry=[{
    'geometry':'wg',
    'bulk_hmax':'20e-9',
    'edge_hmax':'5e-9',
    'edge_thickness':'5e-9',
    'edge_transition_distance':'60e-9',
    'corner_hmax':'5e-9',
    'corner_extent':'5e-9',
    'corner_transition_distance':'40e-9',
}], component_aware=True)
for f in fields:
    if f['kind'] in {'EdgeDistanceThreshold','CornerDistanceThreshold'}:
        print(f['kind'], f['params'])
PY
```

Result shows edge has no `Grading` or `GrowthRate`, while corner is geometric:

```text
EdgeDistanceThreshold {... 'DistMin': 5e-09, 'DistMax': 6.5e-08, 'Sampling': 40, 'Source': 'per_geometry.edge_maximum_element_size'}
CornerDistanceThreshold {... 'DistMin': 5e-09, 'DistMax': 4.5e-08, 'Sampling': 20, 'Grading': 'geometric', ...}
```

## Findings

### Blocker: OCC fallback still cannot recover when edge/corner refinement is active

Evidence:

- `asset_pipeline.py` catches a failed `conformal_occ` build and rebuilds mesh options with `component_aware=False` before concatenated STL fallback: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py:1330`.
- `_perimeter_refinement_config()` raises immediately for any edge/corner request when `component_aware=False`: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:88`.
- The probe above reproduces the same failure mode without running Gmsh.

Impact:

If OCC fails for any unrelated reason, a mesh that requested `edge_hmax`, `edge_thickness`, `corner_hmax`, or `corner_extent` cannot fall back. This matches the recent runtime failure shape: the original OCC issue is hidden behind a second error about edge/corner requiring component-aware meshing.

Recommendation:

Fallback option rebuild should not raise here. Either:

1. downgrade edge/corner fields to bounds-based approximations for fallback, or
2. strip them with an explicit `size_fields_realized.status="ignored"` and keep the primary OCC error as the diagnostic cause.

Add a regression test that forces `generate_shared_domain_mesh_via_occ()` to fail with edge/corner active and asserts the fallback either succeeds or reports a controlled degradation, not a secondary `ValueError`.

### Required: edge refinement ignores geometric grading while corner and transition use it

Evidence:

- Non-box edge fields are built at `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:183`.
- `edge_params` contains `SizeMin`, `SizeMax`, `DistMin`, `DistMax`, and `Sampling`, but no `Grading` or `GrowthRate`: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:194`.
- Corner fields explicitly set `"Grading": "geometric"`: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:225`.
- Transition fields also use `"Grading": "geometric"` and propagate `transition_growth`: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:642`.

Impact:

Air-side edge refinement uses Gmsh `Threshold` linear interpolation, while corner and transition use MathEval geometric grading. This is physically inconsistent and can produce the exact visual symptom already reported: corner/transition refinement appears, but edge-near air grows too abruptly or too uniformly.

Recommendation:

Make edge and corner refinement share one grading policy. At minimum, set `"Grading": "geometric"` on `edge_params`. If no dedicated `edge_growth` API exists, use `transition_growth` or the global mesh growth rate consistently and record the source in `size_fields_realized`.

Add tests that assert `EdgeDistanceThreshold` receives `Grading="geometric"` and, when applicable, `GrowthRate`.

### Required: Box edge/corner refinement is volume-restricted and does not refine air-side edges

Evidence:

- For exact `Box` geometries, `_build_perimeter_refinement_fields()` switches to `ComponentRestrictedBox` subregions: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:243`.
- Those fields are restricted to component volume in `_add_component_restricted_box_field()`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py:840`.
- The Box branch never uses `edge_transition_distance` or `corner_transition_distance`: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py:279`.
- The public DSL validates `edge_transition_distance` as a meaningful option: `packages/fullmag-py/src/fullmag/world.py:564`.

Impact:

For rectangular films, edge/corner controls refine only the magnetic volume strips. They do not produce a smooth air-side edge/corner transition. That violates the shared-domain physical expectation that the final conforming FEM mesh should transition smoothly from the magnetic body into air.

This is not visible for flat `ArchWaveguide` because it goes through the non-box edge/corner distance fields, but it remains a real bug for users who model rectangular films as `fm.Box`.

Recommendation:

Use boundary-curve `EdgeDistanceThreshold` and `CornerDistanceThreshold` for component-aware Box geometry too, or add separate air-side edge/corner fields. If object-interior strip refinement is still useful, keep it as an additional body-only field, not as the only edge/corner implementation.

Add a Box shared-domain test that measures airbox element sizes near box edges and verifies `edge_transition_distance` affects air elements, not only object elements.

### Required: spherical airboxes use rectangular envelope grading

Evidence:

- OCC creates a sphere when `airbox.shape == "sphere"`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py:190` and `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py:197`.
- The same path always passes rectangular `airbox_bounds_min/max` into `_add_airbox_grading_field()`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py:356`.
- `_add_airbox_grading_field()` then unconditionally adds `_add_rectangular_airbox_envelope_field()` when bounds are present: `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py:229`.
- GEO explicitly approximates `shape == "sphere"` with a bounding box: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py:76`.

Impact:

For OCC spherical airboxes, the geometry is spherical but the envelope field is cuboid. The size field will not represent normalized distance to `Gamma_out`; on diagonal directions the spherical boundary lies inside the cuboid envelope. This can keep the mesh finer or coarser than intended at the actual spherical boundary.

For GEO/STL fallback, `sphere` is not spherical at all. It is silently converted to a box.

Recommendation:

Gate the rectangular envelope to `shape == "bbox"`. For `shape == "sphere"`, implement a radial normalized envelope from object center/radius to airbox radius, or skip the envelope and report the limitation. GEO fallback should either implement a sphere-like shell or mark `shape="sphere"` as degraded.

Add an OCC sphere-airbox test that samples element sizes near `Gamma_out` in axial and diagonal directions.

### Required: geometric `growth_rate` is a shape parameter, not a verified layer-to-layer growth bound

Evidence:

- `_geometric_size_profile_expression()` maps a normalized ramp through `log(1 + (g - 1)s) / log(g)`: `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py:30`.
- The result is a continuous target-size curve. It does not compute layers and does not bound adjacent element-size ratios in the generated tetra mesh.
- Gmsh `Mesh.SmoothRatio` is set globally from mesh options, but it is independent of per-field `GrowthRate`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py:139`.

Impact:

The public name `airbox_growth_rate` / `transition_growth` suggests COMSOL-like maximum element growth, but the implementation currently uses it only to shape the MathEval curve. Actual realized element-to-element growth can still violate the expected ratio, especially around thin films, corners, and mixed Min/Max field combinations.

Recommendation:

Decide and document one semantic:

- If this is only a curve-shaping parameter, rename/report it as such in diagnostics.
- If this is meant to be a physical growth bound, add realized growth diagnostics: bin elements by distance from interface/edge/corner and measure adjacent-band median and p95 ratios.

Add tests that verify realized growth bands, not only that the MathEval string contains `log(...)`.

### Required: swept mesh quality reports gamma proxy as SICN

Evidence:

- `_compute_swept_quality()` computes one volume/max-edge proxy named `gamma`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py:684`.
- The same proxy fills `sicn_min`, `sicn_max`, `sicn_mean`, `sicn_p5`, and `sicn_histogram`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py:704`.
- `sicn_histogram` and `gamma_histogram` are NumPy arrays, while `MeshQualityReport` declares `list[int]`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py:710`.

Impact:

Swept-mesh diagnostics can claim SICN values that were never computed. Any UI or acceptance gate reading `sicn_p5` from a swept mesh is getting a mislabeled gamma-like proxy. This can hide inverted/ill-conditioned elements or make a swept mesh look comparable to a Gmsh-quality mesh when it is not.

Recommendation:

Either compute real SICN for swept tetrahedra or leave SICN unavailable and only publish the proxy under a clearly named metric. Convert histograms to plain integer lists before constructing `MeshQualityReport`.

Add a unit test that asserts swept quality distinguishes `sicn` from `gamma`, or explicitly asserts `quality_source="topology_proxy"` if proxy metrics are used.

### Suggestion: per-domain boundary-face counts are always zero

Evidence:

- `_build_mesh_statistics_report()` passes `boundary_face_count=0` for every marker scope: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py:955`.
- Only the global scope receives `mesh.n_boundary_faces`: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py:955`.

Impact:

The UI can show element and node counts per airbox/object, but boundary-face counts per part are not meaningful. This weakens airbox/interface diagnostics, especially when validating whether the airbox region is truly separate from object mesh surfaces.

Recommendation:

Compute per-marker boundary faces by adjacent element marker, or expose separate `interface_boundary_face_count` and `outer_boundary_face_count` scopes. This should be aligned with `Gamma_out` and `mag_air_interface` markers.

## Test Coverage Gaps

Current tests catch the recent `growth_rate` signature regression and some airbox distance behavior, but they do not prove the full physical mesh behavior:

1. No forced-OCC-failure test with edge/corner active.
2. No Box shared-domain test proving air-side edge refinement.
3. No spherical-airbox grading test.
4. No realized growth-ratio test over generated tetrahedra.
5. No swept-quality test proving SICN semantics.

## Overall Assessment

The current meshing pipeline is materially better than the earlier state: OCC conformal meshing, component markers, per-domain statistics, and geometric airbox fields are present. However, the mesh behavior is not fully reliable yet.

The highest-risk remaining issue is fallback robustness: a recoverable OCC failure can still become a hard failure when edge/corner refinement is active. The highest-risk physical issue is edge/box air-side refinement: some controls users expect to affect the airbox near object edges either use a linear ramp or stay confined inside the magnetic volume.

Recommended fix order:

1. Make OCC fallback safe with edge/corner active.
2. Make edge/corner grading semantics consistent and geometric.
3. Extend Box edge/corner refinement to the air side.
4. Split bbox and sphere airbox envelope logic.
5. Correct swept quality metric semantics.
