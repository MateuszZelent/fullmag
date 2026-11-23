"""Etap A regression tests for Python geometry authoring, IR, and OCC selectors.

Covers:
- P0-PY-04: Sphere / primitive / CSG / unknown geometry rendering in script_builder
  with full f64 precision and fail-closed errors (no silent Box(1e-9, 1e-9, 1e-9)).
- P0-PY-01: Ellipse.to_ir() canonical ``radii`` schema + remesh_cli legacy rx/ry fallback.
- P0-PY-03: Canonical ``object_id`` first (with ``name`` fallback) region owner resolution
  across Problem validation, Problem.to_ir() geometry assets, and ModelDefinition.
- P1-PY-02: High-precision translation derived names without ``.6g`` collisions.
- P1-PY-04: Nested ``.translate(t1).translate(t2)`` composition during export flattening.
- P0-PY-06: OCC selector coordinate scaling (``SCALE = 1e6``) with SI diagnostics.
"""
from __future__ import annotations

import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import fullmag as fm
import pytest

from fullmag.init.magnetization import UniformMagnetization
from fullmag.meshing._gmsh_fields import _apply_mesh_options
from fullmag.meshing._gmsh_selectors import resolve_entity_selectors
from fullmag.meshing._gmsh_types import MeshOptions
from fullmag.meshing.remesh_cli import _geometry_from_ir
from fullmag.model import (
    BackendTarget,
    ExecutionMode,
    ExecutionPrecision,
    FieldTarget,
    Ferromagnet,
    Material,
    ObjectRegion,
    Problem,
    RegionalFieldDrive,
    UniformFieldProfile,
)
from fullmag.model.authoring import ModelDefinition
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    _export_geometry_kind_params,
    _render_geometry_expr_from_override,
    _render_shape_expression,
    export_builder_draft,
    render_scene_document_as_script,
)


def _minimal_scene_with_geometry(
    *,
    name: str,
    geometry_kind: str,
    geometry_params: dict[str, object],
    object_id: str | None = None,
) -> dict[str, object]:
    builder = {
        "study_name": "etap_a_scene",
        "backend": "fem",
        "geometries": [
            {
                "name": name,
                "object_id": object_id or f"obj-{name}",
                "role": "magnet",
                "geometry_kind": geometry_kind,
                "geometry_params": geometry_params,
                "material": {
                    "Ms": 800_000.0,
                    "Aex": 13e-12,
                    "alpha": 0.02,
                },
                "initial_state": {
                    "kind": "uniform",
                    "value": [1.0, 0.0, 0.0],
                },
            }
        ],
    }
    return build_scene_document_from_builder(builder)


# ---------------------------------------------------------------------------
# P0-PY-04: Sphere / primitives / precision / fail-closed unknown geometry
# ---------------------------------------------------------------------------


def test_p0_py_04_sphere_23nm_roundtrips_through_script_loader_and_problem_ir(
    tmp_path: Path,
) -> None:
    radius = 23e-9
    scene = _minimal_scene_with_geometry(
        name="nanosphere",
        geometry_kind="Sphere",
        geometry_params={"radius": radius},
    )

    rendered = render_scene_document_as_script(scene)
    assert "fm.Box(1e-9, 1e-9, 1e-9" not in rendered
    assert "fm.Sphere(" in rendered

    script_path = tmp_path / "sphere_scene.py"
    script_path.write_text(rendered, encoding="utf-8")
    loaded = load_problem_from_script(script_path, lightweight_assets=True)
    loaded_entry = loaded.problem.to_ir(include_geometry_assets=False)["geometry"]["entries"][0]
    assert loaded_entry["kind"] == "ellipsoid"
    assert loaded_entry["radii"] == [radius, radius, radius]

    problem_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    ir_entry = problem_ir["geometry"]["entries"][0]
    assert ir_entry["kind"] == "ellipsoid"
    assert ir_entry["radii"] == [radius, radius, radius]


def test_p0_py_04_full_f64_precision_and_cylinder_axis_preserved(tmp_path: Path) -> None:
    rx = 23.123456789012345e-9
    ry = 17.987654321098765e-9
    rz = 5.555555555555555e-9
    axis = (1.0, 0.0, 0.0)

    # Sphere with full IEEE-754 f64 radius
    sphere_expr = _render_geometry_expr_from_override(
        "Sphere", {"radius": rx}, name="sphere_f64", source_root=tmp_path
    )
    sphere_obj = eval(sphere_expr, {"fm": fm})
    assert sphere_obj.rx == rx
    assert sphere_obj.ry == rx
    assert sphere_obj.rz == rx

    # Ellipsoid via canonical `radii` list
    ellipsoid_expr = _render_geometry_expr_from_override(
        "Ellipsoid", {"radii": [rx, ry, rz]}, name="ellipsoid_f64", source_root=tmp_path
    )
    ellipsoid_obj = eval(ellipsoid_expr, {"fm": fm})
    assert (ellipsoid_obj.rx, ellipsoid_obj.ry, ellipsoid_obj.rz) == (rx, ry, rz)

    # Ellipse via canonical `radii` list
    ellipse_expr = _render_geometry_expr_from_override(
        "Ellipse", {"radii": [rx, ry], "height": rz}, name="ellipse_f64", source_root=tmp_path
    )
    ellipse_obj = eval(ellipse_expr, {"fm": fm})
    assert (ellipse_obj.rx, ellipse_obj.ry, ellipse_obj.height) == (rx, ry, rz)

    # Cylinder with non-default axis through BOTH _render_shape_expression & SceneDocument
    cyl_scene = _minimal_scene_with_geometry(
        name="x_cylinder",
        geometry_kind="Cylinder",
        geometry_params={"radius": rx, "height": ry, "axis": list(axis)},
    )
    rendered_cyl = render_scene_document_as_script(cyl_scene)
    assert "axis=" in rendered_cyl
    cyl_ir = scene_document_to_problem_ir(
        cyl_scene,
        requested_backend="fem",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    cyl_entry = cyl_ir["geometry"]["entries"][0]
    assert cyl_entry["kind"] == "cylinder"
    assert cyl_entry["radius"] == rx
    assert cyl_entry["height"] == ry
    assert tuple(cyl_entry["axis"]) == axis

    # _render_shape_expression preserves Cylinder axis and Ellipse radii
    shape_cyl = _render_shape_expression(
        {
            "name": "x_cyl",
            "geometry_kind": "Cylinder",
            "geometry_params": {"radius": rx, "height": ry, "axis": list(axis)},
        }
    )
    parsed_cyl = eval(shape_cyl, {"fm": fm})
    assert parsed_cyl.radius == rx
    assert parsed_cyl.height == ry
    assert parsed_cyl.axis == axis

    shape_ellipse = _render_shape_expression(
        {
            "name": "disk",
            "geometry_kind": "Ellipse",
            "geometry_params": {"radii": [rx, ry], "height": rz},
        }
    )
    parsed_ellipse = eval(shape_ellipse, {"fm": fm})
    assert (parsed_ellipse.rx, parsed_ellipse.ry, parsed_ellipse.height) == (rx, ry, rz)


def test_p0_py_04_csg_and_translate_roundtrip_via_override_renderer(tmp_path: Path) -> None:
    csg_params = {
        "base": {
            "geometry_kind": "Box",
            "geometry_params": {"size": [100.1234567890123e-9, 80e-9, 10e-9]},
        },
        "tool": {
            "geometry_kind": "Translate",
            "geometry_params": {
                "base": {
                    "geometry_kind": "Cylinder",
                    "geometry_params": {"radius": 15e-9, "height": 12e-9, "axis": [0.0, 1.0, 0.0]},
                },
                "translation": [12.3456789012345e-9, -4e-9, 0.0],
            },
        },
    }
    expr = _render_geometry_expr_from_override(
        "Difference", csg_params, name="notched", source_root=tmp_path
    )
    geom = eval(expr, {"fm": fm})
    assert isinstance(geom, fm.Difference)
    assert isinstance(geom.base, fm.Box)
    assert geom.base.size[0] == 100.1234567890123e-9
    assert isinstance(geom.tool, fm.Translate)
    assert geom.tool.offset == (12.3456789012345e-9, -4e-9, 0.0)
    assert isinstance(geom.tool.geometry, fm.Cylinder)
    assert geom.tool.geometry.axis == (0.0, 1.0, 0.0)

    for op_kind, cls in (("Union", fm.Union), ("Intersection", fm.Intersection)):
        op_expr = _render_geometry_expr_from_override(
            op_kind,
            {
                "a": {"geometry_kind": "Sphere", "geometry_params": {"radius": 20e-9}},
                "b": {"geometry_kind": "Box", "geometry_params": {"size": [30e-9, 30e-9, 30e-9]}},
            },
            name=f"test_{op_kind.lower()}",
            source_root=tmp_path,
        )
        op_geom = eval(op_expr, {"fm": fm})
        assert isinstance(op_geom, cls)


@pytest.mark.parametrize("unsupported_kind", ["Cone", "Torus", "PolygonPrism", "MysterySolid"])
def test_p0_py_04_unrecognized_geometry_raises_instead_of_silent_box(
    tmp_path: Path, unsupported_kind: str
) -> None:
    with pytest.raises(ValueError) as exc_info:
        _render_geometry_expr_from_override(
            unsupported_kind,
            {"radius": 10e-9},
            name="bad_body",
            source_root=tmp_path,
        )
    message = str(exc_info.value)
    assert unsupported_kind in message
    assert "bad_body" in message

    with pytest.raises(ValueError) as shape_exc:
        _render_shape_expression(
            {
                "name": "bad_body",
                "geometry_kind": unsupported_kind,
                "geometry_params": {"radius": 10e-9},
            }
        )
    shape_message = str(shape_exc.value)
    assert unsupported_kind in shape_message
    assert "bad_body" in shape_message


# ---------------------------------------------------------------------------
# P0-PY-01: Ellipse.to_ir() `radii` schema & remesh_cli compatibility
# ---------------------------------------------------------------------------


def test_p0_py_01_ellipse_to_ir_emits_canonical_radii_and_remesh_roundtrips() -> None:
    ellipse = fm.Ellipse(23e-9, 17e-9, 5e-9, name="nanodisk")
    ir = ellipse.to_ir()

    assert ir == {
        "name": "nanodisk",
        "kind": "ellipse",
        "radii": [23e-9, 17e-9],
        "height": 5e-9,
    }
    assert "rx" not in ir
    assert "ry" not in ir

    restored = _geometry_from_ir(ir)
    assert isinstance(restored, fm.Ellipse)
    assert restored.rx == 23e-9
    assert restored.ry == 17e-9
    assert restored.height == 5e-9
    assert restored.name == "nanodisk"


def test_p0_py_01_remesh_cli_keeps_legacy_rx_ry_ellipse_fallback() -> None:
    legacy_ir = {
        "name": "legacy_disk",
        "kind": "ellipse",
        "rx": 23e-9,
        "ry": 17e-9,
        "height": 5e-9,
    }
    restored = _geometry_from_ir(legacy_ir)
    assert isinstance(restored, fm.Ellipse)
    assert (restored.rx, restored.ry, restored.height, restored.name) == (
        23e-9,
        17e-9,
        5e-9,
        "legacy_disk",
    )

    with pytest.raises(ValueError, match="ellipse"):
        _geometry_from_ir({"name": "broken", "kind": "ellipse", "height": 5e-9})


# ---------------------------------------------------------------------------
# P0-PY-03: object_id != name region owner split-brain
# ---------------------------------------------------------------------------


def test_p0_py_03_region_owner_resolves_canonical_object_id_and_legacy_name() -> None:
    mat = Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    geom_a = fm.Box(100e-9, 50e-9, 10e-9, name="geom_a")
    geom_b = fm.Box(80e-9, 40e-9, 10e-9, name="geom_b").translate((200e-9, 0.0, 0.0))

    # Intentionally choose magnet_a.object_id == magnet_b.name to verify
    # canonical object_id takes precedence over legacy display name.
    region_canonical = ObjectRegion(
        owner_object="obj-canonical-a",
        name="defect",
        region_id="obj-canonical-a:defect",
        shape=fm.Box(20e-9, 20e-9, 10e-9),
    )
    region_legacy = ObjectRegion(
        owner_object="display_b",
        name="edge",
        region_id="display_b:edge",
        shape=fm.Box(10e-9, 10e-9, 10e-9),
    )

    magnet_a = Ferromagnet(
        name="display_a",
        object_id="obj-canonical-a",
        geometry=geom_a,
        material=mat,
        m0=UniformMagnetization((1.0, 0.0, 0.0)),
        object_regions=(region_canonical,),
    )
    magnet_b = Ferromagnet(
        name="display_b",
        object_id="obj-canonical-b",
        geometry=geom_b,
        material=mat,
        m0=UniformMagnetization((1.0, 0.0, 0.0)),
        object_regions=(region_legacy,),
    )

    # RegionalFieldDrive targeting canonical object_id & its region must validate cleanly
    drive_obj = RegionalFieldDrive(
        id="drive_obj",
        name="Drive Object",
        target=FieldTarget.object("obj-canonical-a"),
        amplitude_B_T=1e-3,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=UniformFieldProfile(),
        waveform=fm.Constant(),
    )
    drive_reg = RegionalFieldDrive(
        id="drive_reg",
        name="Drive Region",
        target=FieldTarget.region("obj-canonical-a", "obj-canonical-a:defect"),
        amplitude_B_T=2e-3,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=UniformFieldProfile(),
        waveform=fm.Constant(),
    )

    problem = Problem(
        name="split_brain_regression",
        magnets=(magnet_a, magnet_b),
        energy=(fm.Exchange(),),
        study=fm.Relaxation(outputs=[], dynamics=fm.LLG(fixed_timestep=1e-13)),
        field_drives=(drive_obj, drive_reg),
    )

    # 1. Problem.to_ir() must pass non-empty canonical owner_geometry_name
    captured: dict[str, object] = {}

    def _fake_build_geometry_assets(**kwargs: object) -> dict[str, object]:
        captured["object_regions"] = kwargs.get("object_regions")
        return {}

    with patch(
        "fullmag.model.problem.build_geometry_assets_for_request",
        side_effect=_fake_build_geometry_assets,
    ):
        problem.to_ir(
            requested_backend=BackendTarget.FEM,
            execution_mode=ExecutionMode.STRICT,
            execution_precision=ExecutionPrecision.DOUBLE,
            include_geometry_assets=True,
        )

    mesh_specs = captured["object_regions"]
    assert isinstance(mesh_specs, list)
    by_region_id = {spec["region_id"]: spec["owner_geometry_name"] for spec in mesh_specs}
    assert by_region_id["obj-canonical-a:defect"] == geom_a.geometry_name
    assert by_region_id["display_b:edge"] == geom_b.geometry_name

    # 2. ModelDefinition.from_problem() must map regions to the right component_id
    model_def = ModelDefinition.from_problem(problem)
    regions_by_component = {
        comp.component_id: comp.region_ids for comp in model_def.components
    }
    assert regions_by_component["obj-canonical-a"] == ("obj-canonical-a:defect",)
    assert regions_by_component["obj-canonical-b"] == ("display_b:edge",)


def test_p0_py_03_canonical_object_id_wins_when_colliding_with_other_magnet_name() -> None:
    mat = Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    geom_a = fm.Box(50e-9, 50e-9, 5e-9, name="geom_a")
    geom_b = fm.Box(50e-9, 50e-9, 5e-9, name="geom_b").translate((100e-9, 0.0, 0.0))

    region = ObjectRegion(
        owner_object="shared_token",
        name="patch",
        region_id="shared_token:patch",
        shape=fm.Box(10e-9, 10e-9, 5e-9),
    )
    magnet_a = Ferromagnet(
        name="display_a",
        object_id="shared_token",
        geometry=geom_a,
        material=mat,
        m0=UniformMagnetization((1.0, 0.0, 0.0)),
        object_regions=(region,),
    )
    magnet_b = Ferromagnet(
        name="shared_token",
        object_id="other_id",
        geometry=geom_b,
        material=mat,
        m0=UniformMagnetization((1.0, 0.0, 0.0)),
    )
    problem = Problem(
        name="precedence_test",
        magnets=(magnet_a, magnet_b),
        energy=(fm.Exchange(),),
        study=fm.Relaxation(outputs=[], dynamics=fm.LLG(fixed_timestep=1e-13)),
    )

    model_def = ModelDefinition.from_problem(problem)
    regions_by_component = {
        comp.component_id: comp.region_ids for comp in model_def.components
    }
    assert regions_by_component["shared_token"] == ("shared_token:patch",)
    assert regions_by_component["other_id"] == ()


# ---------------------------------------------------------------------------
# P1-PY-02 & P1-PY-04: translate derived names & nested translate composition
# ---------------------------------------------------------------------------


def test_p1_py_02_distinct_nanometer_translations_do_not_collide() -> None:
    base = fm.Box(20e-9, 20e-9, 5e-9, name="tile")
    t1 = base.translate((100.0001e-9, 0.0, 0.0))
    t2 = base.translate((100.0002e-9, 0.0, 0.0))
    assert t1.geometry_name != t2.geometry_name

    # Negative zero canonicalizes identically to positive zero
    tz_pos = base.translate((0.0, 50e-9, 0.0))
    tz_neg = base.translate((-0.0, 50e-9, 0.0))
    assert tz_pos.geometry_name == tz_neg.geometry_name

    # Both translated geometries coexist cleanly in the same Problem
    mat = Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    problem = Problem(
        name="two_tiles",
        magnets=(
            Ferromagnet(name="m1", geometry=t1, material=mat, m0=UniformMagnetization((1, 0, 0))),
            Ferromagnet(name="m2", geometry=t2, material=mat, m0=UniformMagnetization((1, 0, 0))),
        ),
        energy=(fm.Exchange(),),
        study=fm.Relaxation(outputs=[], dynamics=fm.LLG(fixed_timestep=1e-13)),
    )
    ir = problem.to_ir(include_geometry_assets=False)
    names = [entry["name"] for entry in ir["geometry"]["entries"]]
    assert len(set(names)) == 2


def test_p1_py_04_nested_translate_composes_offsets_instead_of_overwriting(
    tmp_path: Path,
) -> None:
    t1 = (10e-9, 20e-9, -5e-9)
    t2 = (30e-9, -5e-9, 15e-9)
    nested = fm.Box(40e-9, 30e-9, 10e-9, name="plate").translate(t1).translate(t2)

    kind, params = _export_geometry_kind_params(nested)
    assert kind == "Box"
    translation = params["translation"]
    assert isinstance(translation, list)
    expected = [t1[i] + t2[i] for i in range(3)]
    assert all(math.isclose(translation[i], expected[i], rel_tol=0.0, abs_tol=1e-24) for i in range(3))

    # End-to-end script -> builder draft -> scene -> canonical script -> reload
    script = tmp_path / "nested_translate.py"
    script.write_text(
        """import fullmag as fm
study = fm.study('nested_translate')
study.engine('fem')
body = study.geometry(
    fm.Box(40e-9, 30e-9, 10e-9).translate((10e-9, 20e-9, -5e-9)).translate((30e-9, -5e-9, 15e-9)),
    name='plate',
)
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1, 0, 0)
""",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(script, lightweight_assets=True)
    draft = export_builder_draft(loaded)
    scene = build_scene_document_from_builder(draft)
    rendered = render_scene_document_as_script(scene)
    canonical = tmp_path / "canonical_nested.py"
    canonical.write_text(rendered, encoding="utf-8")
    reloaded = load_problem_from_script(canonical, lightweight_assets=True)
    entry = reloaded.problem.to_ir(include_geometry_assets=False)["geometry"]["entries"][0]
    assert entry["kind"] == "translate"
    assert all(math.isclose(entry["by"][i], expected[i], rel_tol=0.0, abs_tol=1e-24) for i in range(3))


# ---------------------------------------------------------------------------
# P0-PY-06: OCC selector coordinate scaling with SI diagnostics
# ---------------------------------------------------------------------------


def test_p0_py_06_resolve_entity_selectors_scales_query_and_returns_si_diagnostics() -> None:
    scale = 1e6
    calls: list[tuple[float, float, float, list[tuple[int, int]], int]] = []

    class FakeOcc:
        def getClosestEntities(
            self,
            x: float,
            y: float,
            z: float,
            candidates: list[tuple[int, int]],
            n: int = 1,
        ):
            calls.append((x, y, z, list(candidates), n))
            # Return distance and closest point in scaled (micrometer) OCC units
            return [(2, 11)], [2.5e-3], [50e-3, 10e-3, 5e-3]

    class FakeModel:
        occ = FakeOcc()

        def getEntities(self, dim: int) -> list[tuple[int, int]]:
            return [(dim, 11), (dim, 12)]

    fake_gmsh = SimpleNamespace(model=FakeModel())
    selector = {
        "kind": "nearest_surface_to_point",
        "geometry": "film",
        "point": [50e-9, 10e-9, 2.5e-9],
        "count": 1,
    }

    tags, reports = resolve_entity_selectors(
        fake_gmsh,
        [selector],
        dimension=2,
        component_surface_tags={"film": [11, 12]},
        coord_scale=scale,
    )

    assert tags == [11]
    assert len(calls) == 1
    qx, qy, qz, cands, n = calls[0]
    assert math.isclose(qx, 50e-9 * scale, rel_tol=1e-12)
    assert math.isclose(qy, 10e-9 * scale, rel_tol=1e-12)
    assert math.isclose(qz, 2.5e-9 * scale, rel_tol=1e-12)
    assert cands == [(2, 11), (2, 12)]
    assert n == 1

    # Public selector and returned diagnostics must be strictly in SI meters
    assert reports[0]["selector"] == selector
    assert math.isclose(reports[0]["distances"][0], 2.5e-9, rel_tol=1e-12)
    assert all(
        math.isclose(actual, expected, rel_tol=1e-12)
        for actual, expected in zip(reports[0]["closest_points"], [50e-9, 10e-9, 5e-9])
    )

    with pytest.raises(ValueError, match="coord_scale"):
        resolve_entity_selectors(fake_gmsh, [selector], dimension=2, coord_scale=0.0)


def test_p0_py_06_apply_mesh_options_forwards_hscale_to_selectors() -> None:
    scale = 1e6
    recorded_scales: list[float] = []

    def _spy_resolve(
        gmsh: object,
        selectors: object,
        *,
        dimension: int,
        component_surface_tags: object = None,
        coord_scale: float = 1.0,
    ):
        recorded_scales.append(coord_scale)
        return ([7] if dimension == 2 else []), []

    class FakeField:
        def __init__(self) -> None:
            self._next = 1

        def add(self, _kind: str) -> int:
            fid = self._next
            self._next += 1
            return fid

        def setNumber(self, *_args: object) -> None:
            pass

        def setNumbers(self, *_args: object) -> None:
            pass

        def setAsBackgroundMesh(self, *_args: object) -> None:
            pass

    class FakeModel:
        def __init__(self) -> None:
            self.mesh = SimpleNamespace(field=FakeField())

        def getEntities(self, _dim: int) -> list[tuple[int, int]]:
            return []

        def getBoundary(self, *_args: object, **_kwargs: object) -> list[tuple[int, int]]:
            return []

    class FakeOption:
        def setNumber(self, *_args: object) -> None:
            pass

    fake_gmsh = SimpleNamespace(model=FakeModel(), option=FakeOption())
    opts = MeshOptions(
        boundary_layer_count=2,
        boundary_layer_thickness=1e-9,
        boundary_layer_target_surface_selectors=[
            {"kind": "nearest_surface_to_point", "point": [50e-9, 10e-9, 5e-9], "count": 1}
        ],
        boundary_layer_target_curve_selectors=[
            {"kind": "nearest_curve_to_point", "point": [50e-9, 10e-9, 5e-9], "count": 1}
        ],
    )

    with patch(
        "fullmag.meshing._gmsh_fields.resolve_entity_selectors",
        side_effect=_spy_resolve,
    ):
        _apply_mesh_options(
            fake_gmsh,
            hmax=20e-9 * scale,
            order=1,
            opts=opts,
            hscale=scale,
            component_surface_tags={"film": [7]},
        )

    assert recorded_scales == [scale, scale]


def test_p0_py_06_gmsh_occ_scaled_box_selects_top_face_in_si() -> None:
    gmsh = pytest.importorskip("gmsh")
    scale = 1e6
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("etap_a_scaled_selector")
        # Box [0, 100 nm] x [0, 20 nm] x [0, 5 nm] built in micrometer OCC coordinates
        gmsh.model.occ.addBox(0.0, 0.0, 0.0, 100e-9 * scale, 20e-9 * scale, 5e-9 * scale)
        gmsh.model.occ.synchronize()

        # Find the ground-truth top face tag (z == 5e-9 * scale; Gmsh OCC pads bbox by ~1e-7)
        top_tags = [
            tag
            for _dim, tag in gmsh.model.getEntities(2)
            if math.isclose(gmsh.model.getBoundingBox(2, tag)[2], 5e-9 * scale, abs_tol=1e-5)
            and math.isclose(gmsh.model.getBoundingBox(2, tag)[5], 5e-9 * scale, abs_tol=1e-5)
        ]
        assert len(top_tags) == 1

        # Query in SI meters near the top face (z = 4.9e-9 m)
        tags, reports = resolve_entity_selectors(
            gmsh,
            [{"kind": "nearest_surface_to_point", "point": [50e-9, 10e-9, 4.9e-9], "count": 1}],
            dimension=2,
            coord_scale=scale,
        )
        assert tags == top_tags
        assert math.isclose(reports[0]["distances"][0], 0.1e-9, rel_tol=1e-6, abs_tol=1e-15)
        assert math.isclose(reports[0]["closest_points"][2], 5e-9, rel_tol=1e-6, abs_tol=1e-15)
    finally:
        gmsh.finalize()
