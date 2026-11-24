"""Etap B regression and acceptance tests for CSG Boolean, Transform3D, SlicePlane,
new primitives (Cone, Torus, PolygonPrism, Xor), SinWaveguide OCC/preview (P0-PY-02),
fluent Python DSL, SceneDocument -> Python -> ProblemIR roundtrip, and FDM voxelization
(including P1-PY-11 / P1-PY-12 empty mask & disjoint intersection guards).
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

import fullmag as fm
from fullmag.meshing._gmsh_generators import _add_geometry_to_occ
from fullmag.meshing._gmsh_occ import is_occ_compatible
from fullmag.meshing.remesh_cli import _geometry_from_ir
from fullmag.meshing.surface_assets import build_surface_preview_payload
from fullmag.meshing.voxelization import _geometry_bounds, voxelize_geometry
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_scene_document_as_script,
)


def _scene_with_geometry(
    *,
    name: str,
    geometry_kind: str,
    geometry_params: dict[str, object],
) -> dict[str, object]:
    builder = {
        "study_name": "etap_b_scene",
        "backend": "fem",
        "geometries": [
            {
                "name": name,
                "object_id": f"obj-{name}",
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
# 1. Public DSL operators, fluent methods, to_ir(), and remesh_cli roundtrip
# ---------------------------------------------------------------------------


def test_dsl_operators_fluent_methods_and_ir_parity() -> None:
    box_a = fm.Box(100e-9, 50e-9, 10e-9, name="box_a")
    box_b = fm.Box(40e-9, 40e-9, 10e-9, name="box_b").translate((25e-9, 0.0, 0.0))

    # Operators |, -, &, ^ match fluent methods
    assert (box_a | box_b).to_ir() == box_a.union(box_b).to_ir()
    assert (box_a - box_b).to_ir() == box_a.subtract(box_b).to_ir()
    assert (box_a & box_b).to_ir() == box_a.intersect(box_b).to_ir()
    assert (box_a ^ box_b).to_ir() == box_a.xor(box_b).to_ir()

    xor_ir = (box_a ^ box_b).to_ir()
    assert xor_ir["kind"] == "xor"
    assert xor_ir["left"] == box_a.to_ir()
    assert xor_ir["right"] == box_b.to_ir()
    assert _geometry_from_ir(xor_ir).to_ir() == xor_ir

    cone = fm.Cone(20e-9, 5e-9, 30e-9, axis=(0.0, 1.0, 0.0), name="frustum")
    cone_ir = cone.to_ir()
    assert cone_ir == {
        "name": "frustum",
        "kind": "cone",
        "radius_bottom": 20e-9,
        "radius_top": 5e-9,
        "height": 30e-9,
        "axis": [0.0, 1.0, 0.0],
    }
    assert _geometry_from_ir(cone_ir).to_ir() == cone_ir

    torus = fm.Torus(40e-9, 10e-9, axis=(1.0, 0.0, 0.0), name="ring")
    torus_ir = torus.to_ir()
    assert torus_ir == {
        "name": "ring",
        "kind": "torus",
        "major_radius": 40e-9,
        "minor_radius": 10e-9,
        "axis": [1.0, 0.0, 0.0],
    }
    assert _geometry_from_ir(torus_ir).to_ir() == torus_ir

    prism = fm.PolygonPrism(
        vertices_xy=[(0.0, 0.0), (50e-9, 0.0), (50e-9, 20e-9), (20e-9, 20e-9), (20e-9, 50e-9), (0.0, 50e-9)],
        thickness=10e-9,
        name="l_shape",
    )
    prism_ir = prism.to_ir()
    assert prism_ir["kind"] == "polygon_prism"
    assert prism_ir["thickness"] == 10e-9
    assert len(prism_ir["vertices_xy"]) == 6
    assert _geometry_from_ir(prism_ir).to_ir() == prism_ir

    rotated = box_a.rotate(euler_deg=(0.0, 0.0, 90.0), pivot=(10e-9, 0.0, 0.0))
    rot_ir = rotated.to_ir()
    assert rot_ir["kind"] == "transform"
    assert rot_ir["child"] == box_a.to_ir()
    assert math.isclose(rot_ir["rotation_quat"][2], math.sqrt(0.5), rel_tol=1e-12)
    assert math.isclose(rot_ir["rotation_quat"][3], math.sqrt(0.5), rel_tol=1e-12)
    assert rot_ir["pivot"] == [10e-9, 0.0, 0.0]
    assert _geometry_from_ir(rot_ir).to_ir() == rot_ir

    scaled = box_a.scale(2.0, 1.5, 1.0, pivot=(0.0, 5e-9, 0.0))
    scale_ir = scaled.to_ir()
    assert scale_ir["scale"] == [2.0, 1.5, 1.0]
    assert scale_ir["pivot"] == [0.0, 5e-9, 0.0]
    assert _geometry_from_ir(scale_ir).to_ir() == scale_ir

    sliced = box_a.slice_plane(origin=(10e-9, 0.0, 0.0), normal=(1.0, 0.0, 0.0), keep="positive")
    slice_ir = sliced.to_ir()
    assert slice_ir["kind"] == "slice_plane"
    assert slice_ir["plane_origin"] == [10e-9, 0.0, 0.0]
    assert slice_ir["plane_normal"] == [1.0, 0.0, 0.0]
    assert slice_ir["keep_side"] == "positive"
    assert _geometry_from_ir(slice_ir).to_ir() == slice_ir

    # fm.shapes convenience helpers work on solid Geometry
    assert isinstance(fm.shapes.cone(radius_bottom=10e-9, height=20e-9), fm.Cone)
    assert isinstance(fm.shapes.torus(major_radius=30e-9, minor_radius=8e-9), fm.Torus)
    assert isinstance(
        fm.shapes.polygon_prism(vertices_xy=[(0, 0), (1e-8, 0), (0, 1e-8)], thickness=5e-9),
        fm.PolygonPrism,
    )
    assert isinstance(fm.shapes.rotate(box_a, axis=(0, 0, 1), angle_deg=45.0), fm.Transform)
    assert isinstance(fm.shapes.scale(box_a, factors=(2.0, 1.0, 1.0)), fm.Transform)
    assert isinstance(fm.shapes.slice_plane(box_a, normal=(0, 0, 1)), fm.SlicePlane)


# ---------------------------------------------------------------------------
# 2. SceneDocument -> fluent Python -> ProblemIR roundtrip (multi-operand CSG)
# ---------------------------------------------------------------------------


def test_scene_document_multi_operand_difference_with_disabled_tool_and_transforms(
    tmp_path: Path,
) -> None:
    scene = _scene_with_geometry(
        name="perforated_film",
        geometry_kind="Difference",
        geometry_params={
            "operands": [
                {
                    "operand_id": "base_film",
                    "label": "Film",
                    "enabled": True,
                    "geometry": {
                        "geometry_kind": "Box",
                        "geometry_params": {"size": [200e-9, 100e-9, 10e-9]},
                    },
                },
                {
                    "operand_id": "hole_left",
                    "label": "Left Hole",
                    "enabled": True,
                    "geometry": {
                        "geometry_kind": "Cylinder",
                        "geometry_params": {"radius": 15e-9, "height": 12e-9},
                    },
                    "transform": {
                        "translation": [-40e-9, 0.0, 0.0],
                        "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                        "scale": [1.0, 1.0, 1.0],
                        "pivot": [0.0, 0.0, 0.0],
                    },
                },
                {
                    "operand_id": "hole_right",
                    "label": "Right Tilted Hole",
                    "enabled": True,
                    "geometry": {
                        "geometry_kind": "Box",
                        "geometry_params": {"size": [20e-9, 20e-9, 12e-9]},
                    },
                    "transform": {
                        "translation": [40e-9, 0.0, 0.0],
                        "euler_xyz_deg": [0.0, 0.0, 45.0],
                        "scale": [1.0, 1.0, 1.0],
                        "pivot": [0.0, 0.0, 0.0],
                    },
                },
                {
                    "operand_id": "disabled_cutout",
                    "label": "Disabled Hole",
                    "enabled": False,
                    "geometry": {
                        "geometry_kind": "Sphere",
                        "geometry_params": {"radius": 500e-9},
                    },
                },
            ]
        },
    )

    rendered = render_scene_document_as_script(scene)
    assert ".subtract(" in rendered
    assert "disabled_cutout" not in rendered

    ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    entry = ir["geometry"]["entries"][0]
    # Left-folded: Difference(Difference(base, hole_left), hole_right)
    assert entry["kind"] == "difference"
    assert entry["base"]["kind"] == "difference"
    assert entry["base"]["base"]["kind"] == "box"
    assert entry["base"]["tool"]["kind"] == "translate"
    assert entry["base"]["tool"]["by"] == [-40e-9, 0.0, 0.0]
    assert entry["tool"]["kind"] == "transform"
    assert entry["tool"]["translation"] == [40e-9, 0.0, 0.0]


def test_scene_document_roundtrip_for_union_intersect_xor_slice_and_primitives(
    tmp_path: Path,
) -> None:
    cases = [
        (
            "union_boxes",
            "Union",
            {
                "operands": [
                    {
                        "operand_id": "a",
                        "enabled": True,
                        "geometry": {"geometry_kind": "Box", "geometry_params": {"size": [40e-9, 40e-9, 10e-9]}},
                    },
                    {
                        "operand_id": "b",
                        "enabled": True,
                        "geometry": {"geometry_kind": "Box", "geometry_params": {"size": [40e-9, 40e-9, 10e-9]}},
                        "transform": {"translation": [20e-9, 0.0, 0.0]},
                    },
                ]
            },
            "union",
            ".union(",
        ),
        (
            "intersect_solids",
            "Intersection",
            {
                "operands": [
                    {
                        "operand_id": "a",
                        "enabled": True,
                        "geometry": {"geometry_kind": "Box", "geometry_params": {"size": [40e-9, 40e-9, 10e-9]}},
                    },
                    {
                        "operand_id": "b",
                        "enabled": True,
                        "geometry": {"geometry_kind": "Sphere", "geometry_params": {"radius": 25e-9}},
                    },
                ]
            },
            "intersection",
            ".intersect(",
        ),
        (
            "xor_solids",
            "Xor",
            {
                "operands": [
                    {
                        "operand_id": "a",
                        "enabled": True,
                        "geometry": {"geometry_kind": "Box", "geometry_params": {"size": [40e-9, 40e-9, 10e-9]}},
                    },
                    {
                        "operand_id": "b",
                        "enabled": True,
                        "geometry": {"geometry_kind": "Box", "geometry_params": {"size": [40e-9, 40e-9, 10e-9]}},
                        "transform": {"translation": [15e-9, 0.0, 0.0]},
                    },
                ]
            },
            "xor",
            ".xor(",
        ),
        (
            "sliced_box",
            "SlicePlane",
            {
                "child": {"geometry_kind": "Box", "geometry_params": {"size": [60e-9, 40e-9, 10e-9]}},
                "plane_origin_m": [0.0, 0.0, 0.0],
                "plane_normal": [1.0, 0.0, 0.0],
                "keep_side": "positive",
            },
            "slice_plane",
            ".slice_plane(",
        ),
        (
            "cone_body",
            "Cone",
            {"radius_bottom": 20e-9, "radius_top": 5e-9, "height": 30e-9, "axis": [0.0, 0.0, 1.0]},
            "cone",
            "fm.Cone(",
        ),
        (
            "torus_body",
            "Torus",
            {"major_radius": 35e-9, "minor_radius": 8e-9, "axis": [0.0, 0.0, 1.0]},
            "torus",
            "fm.Torus(",
        ),
        (
            "prism_body",
            "PolygonPrism",
            {
                "vertices_xy": [[0.0, 0.0], [40e-9, 0.0], [20e-9, 30e-9]],
                "thickness": 10e-9,
            },
            "polygon_prism",
            "fm.PolygonPrism(",
        ),
    ]

    for name, kind, params, expected_ir_kind, expected_token in cases:
        scene = _scene_with_geometry(name=name, geometry_kind=kind, geometry_params=params)
        rendered = render_scene_document_as_script(scene)
        assert expected_token in rendered

        # Verify script loads & re-exports back through builder -> scene -> IR cleanly
        script_path = tmp_path / f"{name}.py"
        script_path.write_text(rendered, encoding="utf-8")
        loaded = load_problem_from_script(script_path, lightweight_assets=True)
        ir_from_script = loaded.problem.to_ir(include_geometry_assets=False)["geometry"]["entries"][0]
        assert ir_from_script["kind"] == expected_ir_kind

        ir_from_scene = scene_document_to_problem_ir(
            scene,
            requested_backend="fem",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )["geometry"]["entries"][0]
        assert ir_from_scene["kind"] == expected_ir_kind

        # Export back to builder draft -> SceneDocument -> render again
        roundtripped_scene = build_scene_document_from_builder(export_builder_draft(loaded))
        ir_roundtrip = scene_document_to_problem_ir(
            roundtripped_scene,
            requested_backend="fem",
            requested_device="cpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )["geometry"]["entries"][0]
        assert ir_roundtrip["kind"] == expected_ir_kind


# ---------------------------------------------------------------------------
# 3. OCC kernel realization & analytical volumes (including P0-PY-02 SinWaveguide)
# ---------------------------------------------------------------------------


def _occ_volume_m3(geometry: fm.model.geometry.Geometry) -> float:
    gmsh = pytest.importorskip("gmsh")
    scale = 1e6
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("etap_b_occ_vol")
        tags = _add_geometry_to_occ(gmsh, geometry, scale=scale)
        gmsh.model.occ.synchronize()
        vol_tags = [(d, t) for d, t in tags if d == 3]
        assert vol_tags, f"no OCC 3D volumes produced for {type(geometry).__name__}"
        total_scaled = sum(gmsh.model.occ.getMass(d, t) for d, t in vol_tags)
        return total_scaled / (scale ** 3)
    finally:
        gmsh.finalize()


def test_occ_compatibility_and_analytical_volumes() -> None:
    box_a = fm.Box(40e-9, 20e-9, 10e-9)
    box_b = fm.Box(40e-9, 20e-9, 10e-9).translate((20e-9, 0.0, 0.0))
    film = fm.Box(200e-9, 100e-9, 10e-9)
    hole1 = fm.Cylinder(radius=15e-9, height=14e-9).translate((-40e-9, 0.0, 0.0))
    hole2 = fm.Cylinder(radius=10e-9, height=14e-9).translate((40e-9, 0.0, 0.0))
    perforated = film.subtract(hole1).subtract(hole2)

    cone = fm.Cone(20e-9, 10e-9, 30e-9)
    torus = fm.Torus(40e-9, 10e-9)
    prism = fm.PolygonPrism([(0.0, 0.0), (40e-9, 0.0), (40e-9, 20e-9), (0.0, 20e-9)], thickness=10e-9)
    transformed = box_a.transform(
        translation=(10e-9, 0.0, 0.0),
        rotation_quat=fm.model.geometry.quaternion_from_euler_xyz_deg((0.0, 0.0, 45.0)),
        scale=(2.0, 1.5, 1.0),
        pivot=(5e-9, 0.0, 0.0),
    )
    sliced = box_a.slice_plane(origin=(0.0, 0.0, 0.0), normal=(1.0, 0.0, 0.0), keep="positive")
    sin_wg = fm.SinWaveguide(length=200e-9, width=40e-9, height=10e-9, period=100e-9, amplitude=8e-9)

    all_geoms = [
        box_a.union(box_b),
        perforated,
        box_a.intersect(box_b),
        box_a.xor(box_b),
        cone,
        torus,
        prism,
        transformed,
        sliced,
        sin_wg,
    ]
    assert is_occ_compatible(all_geoms)

    # Analytical volumes
    v_box = 40e-9 * 20e-9 * 10e-9
    v_overlap = 20e-9 * 20e-9 * 10e-9
    assert math.isclose(_occ_volume_m3(box_a.union(box_b)), 2 * v_box - v_overlap, rel_tol=1e-4)
    assert math.isclose(_occ_volume_m3(box_a.intersect(box_b)), v_overlap, rel_tol=1e-4)
    assert math.isclose(_occ_volume_m3(box_a.xor(box_b)), 2 * v_box - 2 * v_overlap, rel_tol=1e-4)

    v_perf_expected = 200e-9 * 100e-9 * 10e-9 - math.pi * (15e-9 ** 2 + 10e-9 ** 2) * 10e-9
    assert math.isclose(_occ_volume_m3(perforated), v_perf_expected, rel_tol=1e-4)

    v_cone_expected = (math.pi * 30e-9 / 3.0) * (20e-9 ** 2 + 20e-9 * 10e-9 + 10e-9 ** 2)
    assert math.isclose(_occ_volume_m3(cone), v_cone_expected, rel_tol=1e-4)

    v_torus_expected = 2.0 * (math.pi ** 2) * 40e-9 * (10e-9 ** 2)
    assert math.isclose(_occ_volume_m3(torus), v_torus_expected, rel_tol=1e-4)

    assert math.isclose(_occ_volume_m3(prism), 40e-9 * 20e-9 * 10e-9, rel_tol=1e-4)
    assert math.isclose(_occ_volume_m3(transformed), v_box * 2.0 * 1.5 * 1.0, rel_tol=1e-4)
    assert math.isclose(_occ_volume_m3(sliced), 0.5 * v_box, rel_tol=1e-4)
    # SinWaveguide has constant vertical cross-section width * height along x in [-L/2, L/2]
    assert math.isclose(_occ_volume_m3(sin_wg), 200e-9 * 40e-9 * 10e-9, rel_tol=1e-3)


# ---------------------------------------------------------------------------
# 4. Surface preview (including P0-PY-02 SinWaveguide)
# ---------------------------------------------------------------------------


def test_surface_preview_payloads_for_sin_waveguide_and_etap_b_geometries() -> None:
    pytest.importorskip("trimesh")
    geoms = [
        fm.SinWaveguide(length=200e-9, width=40e-9, height=10e-9, period=100e-9, amplitude=8e-9),
        fm.Cone(20e-9, 5e-9, 30e-9),
        fm.Torus(40e-9, 10e-9),
        fm.PolygonPrism([(0.0, 0.0), (50e-9, 0.0), (50e-9, 20e-9), (20e-9, 20e-9), (20e-9, 50e-9), (0.0, 50e-9)], 10e-9),
        fm.Box(40e-9, 20e-9, 10e-9).rotate(euler_deg=(0.0, 0.0, 30.0)),
        fm.Box(40e-9, 20e-9, 10e-9).slice_plane(origin=(0.0, 0.0, 0.0), normal=(1.0, 0.0, 0.0)),
    ]
    for geom in geoms:
        payload = build_surface_preview_payload(geom)
        assert payload is not None, f"preview returned None for {type(geom).__name__}"
        assert len(payload["nodes"]) > 0
        assert len(payload["facet_nodes"]) > 0
        assert len(payload["facet_nodes"]) % 3 == 0


# ---------------------------------------------------------------------------
# 5. FDM Voxelization: CSG, Transform3D, SlicePlane, new primitives, P1-PY-11/12
# ---------------------------------------------------------------------------


def test_voxelization_union_difference_intersect_xor_transform_and_slice() -> None:
    cell = (2e-9, 2e-9, 2e-9)
    cell_vol = 8e-27

    # 2 boxes Union
    box_a = fm.Box(20e-9, 20e-9, 4e-9)
    box_b = fm.Box(20e-9, 20e-9, 4e-9).translate((10e-9, 0.0, 0.0))
    u_vox = voxelize_geometry(box_a.union(box_b), cell)
    assert math.isclose(int(u_vox.mask.sum()) * cell_vol, 30e-9 * 20e-9 * 4e-9, rel_tol=1e-6)

    # Film with 2 shifted holes Difference
    film = fm.Box(100e-9, 40e-9, 4e-9)
    h1 = fm.Box(10e-9, 10e-9, 6e-9).translate((-25e-9, 0.0, 0.0))
    h2 = fm.Box(10e-9, 10e-9, 6e-9).translate((25e-9, 0.0, 0.0))
    d_vox = voxelize_geometry(film.subtract(h1).subtract(h2), cell)
    expected_d = (100e-9 * 40e-9 - 2.0 * 10e-9 * 10e-9) * 4e-9
    assert math.isclose(int(d_vox.mask.sum()) * cell_vol, expected_d, rel_tol=1e-6)

    # Intersection & Xor
    i_vox = voxelize_geometry(box_a.intersect(box_b), cell)
    assert math.isclose(int(i_vox.mask.sum()) * cell_vol, 10e-9 * 20e-9 * 4e-9, rel_tol=1e-6)

    x_vox = voxelize_geometry(box_a.xor(box_b), cell)
    assert math.isclose(int(x_vox.mask.sum()) * cell_vol, 20e-9 * 20e-9 * 4e-9, rel_tol=1e-6)

    # Rotate 90 deg around Z + scale + non-zero pivot
    rect = fm.Box(40e-9, 10e-9, 4e-9)
    transformed = rect.rotate(euler_deg=(0.0, 0.0, 90.0), pivot=(10e-9, 0.0, 0.0))
    bmin, bmax = _geometry_bounds(transformed)
    # 40x10 rotated 90 deg becomes 10x40
    assert math.isclose(bmax[0] - bmin[0], 10e-9, rel_tol=1e-9)
    assert math.isclose(bmax[1] - bmin[1], 40e-9, rel_tol=1e-9)
    t_vox = voxelize_geometry(transformed, cell)
    assert math.isclose(int(t_vox.mask.sum()) * cell_vol, 40e-9 * 10e-9 * 4e-9, rel_tol=1e-6)

    scaled = rect.scale(2.0, 1.0, 1.0, pivot=(0.0, 0.0, 0.0))
    s_vox = voxelize_geometry(scaled, cell)
    assert math.isclose(int(s_vox.mask.sum()) * cell_vol, 80e-9 * 10e-9 * 4e-9, rel_tol=1e-6)

    # SlicePlane positive + negative == full box
    sp_pos = voxelize_geometry(
        rect.slice_plane(origin=(0.0, 0.0, 0.0), normal=(1.0, 0.0, 0.0), keep="positive"), cell
    )
    sp_neg = voxelize_geometry(
        rect.slice_plane(origin=(0.0, 0.0, 0.0), normal=(1.0, 0.0, 0.0), keep="negative"), cell
    )
    assert int(sp_pos.mask.sum()) + int(sp_neg.mask.sum()) == int(voxelize_geometry(rect, cell).mask.sum())


def test_voxelization_cone_torus_and_concave_polygon_prism() -> None:
    cell = (2e-9, 2e-9, 2e-9)
    cell_vol = 8e-27

    cone = fm.Cone(20e-9, 10e-9, 30e-9)
    c_vox = voxelize_geometry(cone, cell)
    v_cone = (math.pi * 30e-9 / 3.0) * (20e-9 ** 2 + 20e-9 * 10e-9 + 10e-9 ** 2)
    assert math.isclose(int(c_vox.mask.sum()) * cell_vol, v_cone, rel_tol=0.05)

    torus = fm.Torus(30e-9, 10e-9)
    t_vox = voxelize_geometry(torus, cell)
    v_torus = 2.0 * (math.pi ** 2) * 30e-9 * (10e-9 ** 2)
    assert math.isclose(int(t_vox.mask.sum()) * cell_vol, v_torus, rel_tol=0.05)

    # Concave L-shaped PolygonPrism: area = 40*40 - 20*20 = 1200 nm^2, thickness = 4 nm
    l_prism = fm.PolygonPrism(
        [(0.0, 0.0), (40e-9, 0.0), (40e-9, 20e-9), (20e-9, 20e-9), (20e-9, 40e-9), (0.0, 40e-9)],
        thickness=4e-9,
    )
    p_vox = voxelize_geometry(l_prism, cell)
    assert math.isclose(int(p_vox.mask.sum()) * cell_vol, 1200e-18 * 4e-9, rel_tol=1e-6)


def test_voxelization_rejects_disjoint_intersection_and_empty_masks() -> None:
    # P1-PY-12: Disjoint Intersection must NOT produce a bogus 1x1x1 voxel box
    a = fm.Box(10e-9, 10e-9, 10e-9)
    b = fm.Box(10e-9, 10e-9, 10e-9).translate((100e-9, 0.0, 0.0))
    with pytest.raises(ValueError, match="empty_geometry_intersection"):
        voxelize_geometry(a.intersect(b), (2e-9, 2e-9, 2e-9))

    # P1-PY-11: Completely subtracted Difference must raise empty_voxel_mask
    bigger = fm.Box(50e-9, 50e-9, 50e-9)
    with pytest.raises(ValueError, match="empty_voxel_mask"):
        voxelize_geometry(a.subtract(bigger), (2e-9, 2e-9, 2e-9))

    # SlicePlane outside geometry must raise empty_geometry_slice
    with pytest.raises(ValueError, match="empty_geometry_slice"):
        voxelize_geometry(
            a.slice_plane(origin=(100e-9, 0.0, 0.0), normal=(1.0, 0.0, 0.0), keep="positive"),
            (2e-9, 2e-9, 2e-9),
        )
