# Gmsh Semantic Entity Selectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reproducible FEM mesh entity selectors backed by Gmsh 4.15 `occ.getClosestEntities`, plus orphan-entity diagnostics in shared-domain mesh reports.

**Architecture:** Public `fm.mesh` helpers produce serializable selector dictionaries. Runtime metadata stores requested selectors separately from raw resolved tags. The Gmsh adapter resolves selectors after geometry realization, unions resolved tags with explicit tag lists, and reports resolved tags and orphan diagnostics through mesh build artifacts.

**Tech Stack:** Python 3.12, `uv`, `gmsh 4.15.2`, `pytest`, Fullmag `packages/fullmag-py`.

---

## File Structure

- Modify `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`
  - Add public selector helper dictionaries.
  - Extend `boundary_layers()` to accept selectors while preserving explicit tag lists.
- Modify `packages/fullmag-py/src/fullmag/meshing/__init__.py`
  - Export selector helpers.
- Modify `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
  - Add selector fields to `MeshOptions`.
  - Add selector diagnostics fields to `SharedDomainMeshResult`.
- Create `packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`
  - Normalize selectors.
  - Resolve nearest surface/curve selectors.
  - Collect orphan-entity diagnostics.
- Modify `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
  - Resolve boundary-layer selectors before creating the boundary-layer field.
  - Resolve optional `EdgeDistanceThreshold` curve selectors.
  - Return a small application report from `_apply_mesh_options()`.
- Modify `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
  - Pass selector diagnostics through `SharedDomainMeshResult`.
- Modify `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`
  - Add selector/orphan fields to `SharedDomainBuildReport.to_dict()`.
- Modify `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
  - Include selector/orphan diagnostics in the typed report.
  - Update boundary-layer operation status to treat selectors as valid targets.
- Modify `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
  - Parse selector lists from runtime metadata.
- Modify `packages/fullmag-py/src/fullmag/world.py`
  - Store selectors in `_MeshSpecState`.
  - Accept selector kwargs on object mesh and defaults APIs.
  - Export selectors into mesh workflow metadata.
- Modify `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
  - Preserve selector dictionaries in exported scripts.
- Modify `packages/fullmag-py/tests/test_meshing.py`
  - Add unit and real-Gmsh selector tests.
- Modify `packages/fullmag-py/tests/test_api.py`
  - Add public helper and script export tests.

## Task 1: Public Selector Helpers

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/__init__.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`

- [ ] **Step 1: Write failing tests for selector helper output**

Add tests near existing `test_mesh_control_wrappers_validate_and_emit_size_fields`:

```python
def test_mesh_control_wrappers_emit_nearest_entity_selectors(self) -> None:
    surface = fm.mesh.nearest_surface_to_point(
        point=(50e-9, 0.0, 2.5e-9),
        geometry="free_layer",
    )
    curve = fm.mesh.nearest_curve_to_point(
        point=(50e-9, 20e-9, 2.5e-9),
        geometry="free_layer",
        count=2,
    )

    self.assertEqual(
        surface,
        {
            "kind": "nearest_surface_to_point",
            "geometry": "free_layer",
            "point": [50e-9, 0.0, 2.5e-9],
            "count": 1,
        },
    )
    self.assertEqual(curve["kind"], "nearest_curve_to_point")
    self.assertEqual(curve["point"], [50e-9, 20e-9, 2.5e-9])
    self.assertEqual(curve["count"], 2)
```

- [ ] **Step 2: Write failing tests for boundary layer selector payload**

Add:

```python
def test_boundary_layers_accepts_semantic_selectors(self) -> None:
    surface = fm.mesh.nearest_surface_to_point(
        point=(50e-9, 0.0, 2.5e-9),
        geometry="free_layer",
    )
    controls = fm.mesh.boundary_layers(
        count=3,
        first_layer_thickness=1e-9,
        stretching=1.25,
        target_surface_tags=[11],
        target_surfaces=[surface],
    )

    self.assertEqual(controls["boundary_layer_count"], 3)
    self.assertEqual(controls["boundary_layer_target_surface_tags"], [11])
    self.assertEqual(controls["boundary_layer_target_surface_selectors"], [surface])
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k 'nearest_entity_selectors or boundary_layers_accepts_semantic_selectors' -q
```

Expected: failures because `nearest_surface_to_point`, `nearest_curve_to_point`, or `target_surfaces` do not exist.

- [ ] **Step 4: Implement helper validation**

Add to `mesh_controls.py`:

```python
def _point3(name: str, value: Sequence[Number]) -> list[float]:
    values = [float(component) for component in value]
    if len(values) != 3:
        raise ValueError(f"{name} must be a 3-vector")
    return values


def _selector_count(value: int) -> int:
    count = int(value)
    if count < 1:
        raise ValueError(f"count must be >= 1, got {value!r}")
    return count


def nearest_surface_to_point(
    *,
    point: Sequence[Number],
    geometry: str | None = None,
    count: int = 1,
) -> dict[str, Any]:
    selector: dict[str, Any] = {
        "kind": "nearest_surface_to_point",
        "point": _point3("point", point),
        "count": _selector_count(count),
    }
    if geometry is not None:
        selector["geometry"] = _geometry_name(geometry)
    return selector


def nearest_curve_to_point(
    *,
    point: Sequence[Number],
    geometry: str | None = None,
    count: int = 1,
) -> dict[str, Any]:
    selector: dict[str, Any] = {
        "kind": "nearest_curve_to_point",
        "point": _point3("point", point),
        "count": _selector_count(count),
    }
    if geometry is not None:
        selector["geometry"] = _geometry_name(geometry)
    return selector
```

Extend `boundary_layers()`:

```python
def boundary_layers(
    *,
    count: int,
    first_layer_thickness: Number,
    stretching: Number = 1.2,
    target_surface_tags: Sequence[int] | None = None,
    target_curve_tags: Sequence[int] | None = None,
    target_surfaces: Sequence[dict[str, Any]] | None = None,
    target_curves: Sequence[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    surface_tags = [int(tag) for tag in target_surface_tags or ()]
    curve_tags = [int(tag) for tag in target_curve_tags or ()]
    surface_selectors = [dict(selector) for selector in target_surfaces or ()]
    curve_selectors = [dict(selector) for selector in target_curves or ()]
    if not surface_tags and not curve_tags and not surface_selectors and not curve_selectors:
        raise ValueError(
            "boundary_layers requires target_surface_tags, target_curve_tags, "
            "target_surfaces, or target_curves"
        )
    return {
        "boundary_layer_count": _at_least_one_int("count", count),
        "boundary_layer_thickness": _positive_float(
            "first_layer_thickness", first_layer_thickness
        ),
        "boundary_layer_stretching": _positive_float("stretching", stretching),
        "boundary_layer_target_surface_tags": surface_tags,
        "boundary_layer_target_curve_tags": curve_tags,
        "boundary_layer_target_surface_selectors": surface_selectors,
        "boundary_layer_target_curve_selectors": curve_selectors,
    }
```

Export helpers from `meshing/__init__.py`.

- [ ] **Step 5: Run tests and verify they pass**

Run the same command from Step 3.

Expected: selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/fullmag-py/src/fullmag/meshing/mesh_controls.py \
  packages/fullmag-py/src/fullmag/meshing/__init__.py \
  packages/fullmag-py/tests/test_meshing.py
git commit -m "feat: add gmsh semantic mesh selector helpers"
```

## Task 2: Runtime Metadata and Script Round-Trip

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_api.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`

- [ ] **Step 1: Write failing runtime metadata parsing test**

Add to `test_meshing.py` near boundary-layer metadata tests:

```python
def test_mesh_options_from_runtime_metadata_parses_boundary_layer_selectors(self) -> None:
    selector = {
        "kind": "nearest_surface_to_point",
        "geometry": "body",
        "point": [50e-9, 0.0, 2.5e-9],
        "count": 1,
    }
    options = _mesh_options_from_runtime_metadata(
        {
            "mesh_options": {
                "boundary_layer_count": 3,
                "boundary_layer_thickness": "1e-9",
                "boundary_layer_target_surface_selectors": [selector],
            }
        },
        geometries=[fm.Box(100e-9, 20e-9, 5e-9, name="body")],
        default_hmax=20e-9,
    )

    self.assertEqual(options.boundary_layer_count, 3)
    self.assertEqual(options.boundary_layer_target_surface_selectors, [selector])
```

- [ ] **Step 2: Write failing public script export test**

Add to `test_api.py` near `test_public_boundary_layers_helper_exports_runtime_metadata`:

```python
def test_public_boundary_layer_selectors_export_runtime_metadata(self) -> None:
    script = """
    import fullmag as fm

    study = fm.study("boundary_layer_selectors")
    study.engine("fem")
    body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name="body")
    body.Ms = 800e3
    body.Aex = 13e-12
    body.alpha = 0.1
    body.m = fm.texture.uniform(1, 0, 0)
    body.mesh(
        maximum_element_size=20e-9,
        **fm.mesh.boundary_layers(
            count=3,
            first_layer_thickness=1e-9,
            target_surfaces=[
                fm.mesh.nearest_surface_to_point(
                    point=(50e-9, 0.0, 2.5e-9),
                    geometry="body",
                )
            ],
        ),
    )
    """

    with TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "script_boundary_layer_selectors.py"
        path.write_text(textwrap.dedent(script), encoding="utf-8")
        with patch("fullmag.world.build_geometry_assets_for_request", return_value=None):
            loaded = fm.load_problem_from_script(path)

    mesh_entry = export_builder_draft(loaded)["geometries"][0]["mesh"]
    self.assertEqual(
        mesh_entry["boundary_layer_target_surface_selectors"][0]["kind"],
        "nearest_surface_to_point",
    )
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_mesh_options_from_runtime_metadata_parses_boundary_layer_selectors \
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_public_boundary_layer_selectors_export_runtime_metadata -q
```

Expected: failures because `MeshOptions` and `world.py` do not preserve selector fields.

- [ ] **Step 4: Add selector fields to `MeshOptions`**

Add to `MeshOptions`:

```python
boundary_layer_target_surface_selectors: list[dict[str, Any]] = field(default_factory=list)
boundary_layer_target_curve_selectors: list[dict[str, Any]] = field(default_factory=list)
```

- [ ] **Step 5: Parse selector fields in `_size_field_plan.py`**

Add local helper:

```python
def _selector_list(value: object) -> list[dict[str, object]] | None:
    if not isinstance(value, list):
        return None
    return [dict(item) for item in value if isinstance(item, Mapping)]
```

Read:

```python
raw_boundary_layer_surface_selectors = _first_non_none(
    raw_mesh_options.get("boundary_layer_target_surface_selectors"),
    _single_geometry_value("boundary_layer_target_surface_selectors"),
)
raw_boundary_layer_curve_selectors = _first_non_none(
    raw_mesh_options.get("boundary_layer_target_curve_selectors"),
    _single_geometry_value("boundary_layer_target_curve_selectors"),
)
```

Pass them to `MeshOptions`.

- [ ] **Step 6: Preserve selectors in `world.py`**

Add `_MeshSpecState` fields:

```python
boundary_layer_target_surface_selectors: list[dict[str, object]] | None = None
boundary_layer_target_curve_selectors: list[dict[str, object]] | None = None
```

Add optional parameters to object mesh and defaults APIs:

```python
boundary_layer_target_surface_selectors: Sequence[Mapping[str, object]] | None = None,
boundary_layer_target_curve_selectors: Sequence[Mapping[str, object]] | None = None,
```

Normalize with:

```python
def _normalize_selector_dicts(
    values: Sequence[Mapping[str, object]],
    *,
    context: str,
) -> list[dict[str, object]]:
    selectors: list[dict[str, object]] = []
    for value in values:
        if not isinstance(value, Mapping):
            raise ValueError(f"{context} entries must be objects")
        selectors.append(dict(value))
    return selectors
```

Include both selector lists in `_mesh_spec_to_runtime_payload()` and global mesh workflow payload.

- [ ] **Step 7: Preserve selectors in script export**

In `script_builder.py`, extend the boundary-layer key loop:

```python
for key in (
    "boundary_layer_target_surface_tags",
    "boundary_layer_target_curve_tags",
    "boundary_layer_target_surface_selectors",
    "boundary_layer_target_curve_selectors",
):
    value = mesh_config.get(key)
    if isinstance(value, list) and value:
        kwargs.append(f"{key}={_py_literal(value)}")
```

- [ ] **Step 8: Run tests and verify they pass**

Run the command from Step 3.

Expected: both tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py \
  packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py \
  packages/fullmag-py/src/fullmag/world.py \
  packages/fullmag-py/src/fullmag/runtime/script_builder.py \
  packages/fullmag-py/tests/test_api.py \
  packages/fullmag-py/tests/test_meshing.py
git commit -m "feat: preserve gmsh semantic selectors in mesh metadata"
```

## Task 3: Gmsh Selector Resolver

**Files:**
- Create: `packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`

- [ ] **Step 1: Write failing fake-Gmsh resolver tests**

Add tests:

```python
def test_resolve_nearest_surface_selector_uses_component_candidates(self) -> None:
    from fullmag.meshing._gmsh_selectors import resolve_entity_selectors

    class _FakeOcc:
        def getClosestEntities(self, x, y, z, dimTags, n=1):
            self.call = (x, y, z, list(dimTags), n)
            return [(2, 12)]

        def getBoundingBox(self, dim, tag):
            return (1.0, -1.0, -1.0, 1.0, 1.0, 1.0)

    class _FakeModel:
        def __init__(self):
            self.occ = _FakeOcc()

        def getEntities(self, dim):
            return [(dim, 99)]

    fake = type("FakeGmsh", (), {"model": _FakeModel()})()
    selectors = [
        {
            "kind": "nearest_surface_to_point",
            "geometry": "body",
            "point": [1e-6, 0.0, 0.0],
            "count": 1,
        }
    ]

    tags, reports = resolve_entity_selectors(
        fake,
        selectors,
        target_dimension=2,
        component_surface_tags={"body": [11, 12]},
        component_volume_tags={},
        hscale=1e6,
    )

    self.assertEqual(tags, [12])
    self.assertEqual(fake.model.occ.call[3], [(2, 11), (2, 12)])
    self.assertEqual(reports[0]["status"], "resolved")
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k 'resolve_nearest_surface_selector_uses_component_candidates' -q
```

Expected: import failure for `_gmsh_selectors`.

- [ ] **Step 3: Implement `_gmsh_selectors.py`**

Create:

```python
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any


def normalize_entity_selector(selector: Mapping[str, object]) -> dict[str, object]:
    kind = selector.get("kind")
    if kind not in {"nearest_surface_to_point", "nearest_curve_to_point"}:
        raise ValueError(f"unsupported mesh entity selector kind: {kind!r}")
    point = selector.get("point")
    if not isinstance(point, Sequence) or isinstance(point, (str, bytes)):
        raise ValueError("mesh entity selector point must be a 3-vector")
    values = [float(component) for component in point]
    if len(values) != 3 or any(not math.isfinite(value) for value in values):
        raise ValueError("mesh entity selector point must contain three finite values")
    count = int(selector.get("count", 1))
    if count < 1:
        raise ValueError("mesh entity selector count must be >= 1")
    normalized: dict[str, object] = {"kind": kind, "point": values, "count": count}
    geometry = selector.get("geometry")
    if geometry is not None:
        name = str(geometry).strip()
        if not name:
            raise ValueError("mesh entity selector geometry must be non-empty")
        normalized["geometry"] = name
    return normalized
```

Add `resolve_entity_selectors()` with parameters:

```python
def resolve_entity_selectors(
    gmsh: Any,
    selectors: Sequence[Mapping[str, object]],
    *,
    target_dimension: int,
    component_surface_tags: dict[str, list[int]] | None,
    component_volume_tags: dict[str, list[int]] | None,
    hscale: float,
) -> tuple[list[int], list[dict[str, object]]]:
```

Implementation rules:

- validate each selector with `normalize_entity_selector()`;
- reject a surface selector when `target_dimension != 2`;
- reject a curve selector when `target_dimension != 1`;
- for surfaces, candidates are component surface tags or all `gmsh.model.getEntities(2)`;
- for curves, candidates are boundary curves from component surfaces or all `gmsh.model.getEntities(1)`;
- call `gmsh.model.occ.getClosestEntities()` when present;
- return sorted unique resolved tags and report dictionaries;
- raise `ValueError` when no candidates or no resolved entities are found.

Add:

```python
def collect_orphan_entity_diagnostics(gmsh: Any) -> list[dict[str, int]]:
    if not hasattr(gmsh.model, "isEntityOrphan"):
        return []
    diagnostics: list[dict[str, int]] = []
    for dim in range(4):
        for _, tag in gmsh.model.getEntities(dim):
            if gmsh.model.isEntityOrphan(dim, tag):
                diagnostics.append({"dim": int(dim), "tag": int(tag)})
    return diagnostics
```

- [ ] **Step 4: Run fake-Gmsh resolver tests**

Run the command from Step 2.

Expected: selected test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py \
  packages/fullmag-py/tests/test_meshing.py
git commit -m "feat: resolve gmsh semantic mesh entity selectors"
```

## Task 4: Wire Selectors Into Gmsh Mesh Application

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`

- [ ] **Step 1: Write failing real-Gmsh boundary-layer selector test**

Add:

```python
def test_boundary_layer_nearest_surface_selector_generates_mesh(self) -> None:
    try:
        mesh = generate_box_mesh(
            (100e-9, 20e-9, 5e-9),
            hmax=20e-9,
            options=MeshOptions(
                compute_quality=False,
                per_element_quality=False,
                boundary_layer_count=2,
                boundary_layer_thickness=1e-9,
                boundary_layer_target_surface_selectors=[
                    {
                        "kind": "nearest_surface_to_point",
                        "point": [50e-9, 0.0, 0.0],
                        "count": 1,
                    }
                ],
            ),
        )
    except ImportError as exc:
        self.skipTest(f"gmsh not available: {exc}")

    self.assertGreater(mesh.n_nodes, 0)
    self.assertGreater(mesh.n_elements, 0)
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
env UV_CACHE_DIR=/tmp/fullmag-uv-cache UV_PYTHON_INSTALL_DIR=/tmp/fullmag-uv-python \
  /tmp/fullmag-uv/bin/uv run --project packages/fullmag-py --all-extras --locked \
  pytest packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_boundary_layer_nearest_surface_selector_generates_mesh -q
```

Expected: fail because `_apply_mesh_options()` ignores selector fields.

- [ ] **Step 3: Return application report from `_apply_mesh_options()`**

At the end of `_apply_mesh_options()`, return:

```python
return {
    "selector_resolution": selector_resolution_reports,
    "orphan_entities": collect_orphan_entity_diagnostics(gmsh),
}
```

Initialize `selector_resolution_reports: list[dict[str, object]] = []` near the start.

- [ ] **Step 4: Resolve boundary-layer selectors before `_add_boundary_layer_field()`**

Before `_add_boundary_layer_field()`:

```python
surface_tags = list(opts.boundary_layer_target_surface_tags or [])
curve_tags = list(opts.boundary_layer_target_curve_tags or [])
if opts.boundary_layer_target_surface_selectors:
    resolved_tags, reports = resolve_entity_selectors(
        gmsh,
        opts.boundary_layer_target_surface_selectors,
        target_dimension=2,
        component_surface_tags=component_surface_tags,
        component_volume_tags=component_volume_tags,
        hscale=hscale,
    )
    surface_tags.extend(resolved_tags)
    selector_resolution_reports.extend(reports)
if opts.boundary_layer_target_curve_selectors:
    resolved_tags, reports = resolve_entity_selectors(
        gmsh,
        opts.boundary_layer_target_curve_selectors,
        target_dimension=1,
        component_surface_tags=component_surface_tags,
        component_volume_tags=component_volume_tags,
        hscale=hscale,
    )
    curve_tags.extend(resolved_tags)
    selector_resolution_reports.extend(reports)
```

Pass `surface_tags` and `curve_tags` to `_add_boundary_layer_field()`.

- [ ] **Step 5: Resolve optional `EdgeDistanceThreshold` curve selector**

In `_curve_tags_for_geometry()`, support:

```python
curve_selector = params.get("CurveSelector")
if isinstance(curve_selector, Mapping):
    tags, reports = resolve_entity_selectors(
        gmsh,
        [curve_selector],
        target_dimension=1,
        component_surface_tags=component_surface_tags,
        component_volume_tags=component_volume_tags,
        hscale=hscale,
    )
    params["_gmsh_selector_resolution"] = reports
    return tags
```

Use component surface tags and `target_dimension=1`.

- [ ] **Step 6: Run selected real-Gmsh test**

Run the command from Step 2.

Expected: selected test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py \
  packages/fullmag-py/tests/test_meshing.py
git commit -m "feat: apply gmsh semantic selectors during meshing"
```

## Task 5: Report Selector and Orphan Diagnostics

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`
- Modify: `packages/fullmag-py/tests/test_meshing.py`

- [ ] **Step 1: Write failing shared-domain report test**

Add:

```python
def test_shared_domain_report_includes_selector_resolution(self) -> None:
    selector_report = {
        "kind": "nearest_surface_to_point",
        "status": "resolved",
        "resolved_tags": [17],
    }
    report = _build_shared_domain_build_report(
        [fm.Box(10e-9, 10e-9, 5e-9, name="body")],
        FEM(hmax=10e-9),
        airbox=None,
        mesh_workflow={"mesh_options": {}},
        per_object_recipes=None,
        size_fields=[],
        region_markers=[{"geometry_name": "body", "marker": 1}],
        build_mode="component_aware",
        fallbacks_triggered=[],
        mesh_options=MeshOptions(
            boundary_layer_count=2,
            boundary_layer_thickness=1e-9,
            boundary_layer_target_surface_selectors=[
                {
                    "kind": "nearest_surface_to_point",
                    "geometry": "body",
                    "point": [5e-9, 0.0, 0.0],
                }
            ],
        ),
        selector_resolution=[selector_report],
        orphan_entities=[{"dim": 2, "tag": 99}],
    )

    payload = report.to_dict()
    self.assertEqual(payload["selector_resolution"], [selector_report])
    self.assertEqual(payload["orphan_entities"], [{"dim": 2, "tag": 99}])
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  -k 'shared_domain_report_includes_selector_resolution' -q
```

Expected: failure because report fields and parameters do not exist.

- [ ] **Step 3: Add fields to result/report dataclasses**

In `SharedDomainMeshResult`:

```python
selector_resolution: list[dict[str, object]] = field(default_factory=list)
orphan_entities: list[dict[str, int]] = field(default_factory=list)
```

In `SharedDomainBuildReport`:

```python
selector_resolution: list[dict[str, object]] = field(default_factory=list)
orphan_entities: list[dict[str, int]] = field(default_factory=list)
```

Include both in `to_dict()`.

- [ ] **Step 4: Thread reports through shared-domain generation**

Capture `_apply_mesh_options()` return in `generate_shared_domain_mesh_from_components()`:

```python
mesh_application_report = _apply_mesh_options(
    gmsh,
    hmax,
    order,
    shared_stl_opts,
    preexisting_field_ids=airbox_field_ids,
    preexisting_lower_bound_field_ids=airbox_lower_bound_field_ids,
    component_volume_tags=component_volume_tags,
    component_surface_tags=component_surface_tags,
    airbox_maximum_element_size=(
        airbox.maximum_element_size if airbox is not None else None
    ),
)
```

Pass:

```python
selector_resolution=list(mesh_application_report.get("selector_resolution", [])),
orphan_entities=list(mesh_application_report.get("orphan_entities", [])),
```

into `SharedDomainMeshResult`.

Pass those values from `asset_pipeline.py` to `_build_shared_domain_build_report()`.

- [ ] **Step 5: Update boundary-layer operation status**

In `mesh_build_report.py`, compute:

```python
boundary_layer_has_selectors = bool(opts.boundary_layer_target_surface_selectors) or bool(
    opts.boundary_layer_target_curve_selectors
)
boundary_layer_has_targets = bool(opts.boundary_layer_target_surface_tags) or bool(
    opts.boundary_layer_target_curve_tags
) or boundary_layer_has_selectors
```

Include selector lists in `details`.

- [ ] **Step 6: Run report test**

Run the command from Step 2.

Expected: selected test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py \
  packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py \
  packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py \
  packages/fullmag-py/tests/test_meshing.py
git commit -m "feat: report gmsh selector diagnostics"
```

## Task 6: Final Verification

**Files:**
- No new files.
- Validate all changed Python meshing and API surfaces.

- [ ] **Step 1: Run focused API tests**

Run:

```bash
env UV_CACHE_DIR=/tmp/fullmag-uv-cache UV_PYTHON_INSTALL_DIR=/tmp/fullmag-uv-python \
  /tmp/fullmag-uv/bin/uv run --project packages/fullmag-py --all-extras --locked \
  pytest packages/fullmag-py/tests/test_api.py \
  -k 'boundary_layer_selectors or boundary_layers_helper' -q
```

Expected: selected tests pass.

- [ ] **Step 2: Run full meshing suite**

Run:

```bash
env UV_CACHE_DIR=/tmp/fullmag-uv-cache UV_PYTHON_INSTALL_DIR=/tmp/fullmag-uv-python \
  /tmp/fullmag-uv/bin/uv run --project packages/fullmag-py --all-extras --locked \
  pytest packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_meshing_fallbacks.py -q
```

Expected: all meshing tests pass.

- [ ] **Step 3: Run full Python API suite**

Run:

```bash
env UV_CACHE_DIR=/tmp/fullmag-uv-cache UV_PYTHON_INSTALL_DIR=/tmp/fullmag-uv-python \
  /tmp/fullmag-uv/bin/uv run --project packages/fullmag-py --all-extras --locked \
  pytest packages/fullmag-py/tests/test_api.py -q
```

Expected: all API tests pass.

- [ ] **Step 4: Run syntax check**

Run:

```bash
python3 -m py_compile \
  packages/fullmag-py/src/fullmag/meshing/mesh_controls.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py \
  packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py \
  packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py \
  packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py \
  packages/fullmag-py/src/fullmag/world.py \
  packages/fullmag-py/src/fullmag/runtime/script_builder.py
```

Expected: exit code 0.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat
git diff -- packages/fullmag-py/src/fullmag/meshing packages/fullmag-py/src/fullmag/world.py packages/fullmag-py/src/fullmag/runtime/script_builder.py packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_api.py
```

Expected: diff only contains selector/orphan diagnostics work and related tests.

- [ ] **Step 6: Commit final verification marker if needed**

If all previous commits were made task-by-task, no extra commit is required. If final fixes were made during verification, commit them:

```bash
git add packages/fullmag-py/src/fullmag packages/fullmag-py/tests
git commit -m "test: verify gmsh semantic selector workflow"
```
