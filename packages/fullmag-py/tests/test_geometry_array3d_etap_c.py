"""Etap C tests for Array3D parametric Bravais / stepped lattices across Python DSL,
SceneDocument -> Python -> ProblemIR roundtrip, Gmsh OCC realization (antidots, dots,
merge_overlapping, budget limits), surface preview, and O(1 + K*C) inverse FDM voxelization
verified bit-for-bit against a brute-force reference loop.
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
from fullmag.meshing.voxelization import _contains, _geometry_bounds, voxelize_geometry
from fullmag.model.geometry import (
    Array3D,
    ArrayAxisSpec,
    MAX_ARRAY_AXIS_COUNT,
    MAX_ARRAY_INSTANCES_FDM,
    MAX_ARRAY_INSTANCES_FEM_OCC,
)
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
        "study_name": "etap_c_array3d",
        "backend": "fem",
        "geometries": [
            {
                "name": name,
                "object_id": f"obj-{name}",
                "role": "magnet",
                "geometry_kind": geometry_kind,
                "geometry_params": geometry_params,
                "material": {"Ms": 800_000.0, "Aex": 13e-12, "alpha": 0.02},
                "initial_state": {"kind": "uniform", "value": [1.0, 0.0, 0.0]},
            }
        ],
    }
    return build_scene_document_from_builder(builder)


def _reference_array3d_contains(
    array_geom: Array3D,
    xx: np.ndarray,
    yy: np.ndarray,
    zz: np.ndarray,
) -> np.ndarray:
    """Naive O(M) brute-force reference evaluator over every instance."""
    cmin, cmax = _geometry_bounds(array_geom.child)
    extent = (cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2])
    mask = np.zeros(xx.shape, dtype=np.bool_)
    for (tx, ty, tz), q, (sx, sy, sz) in array_geom.instance_transforms(extent):
        if array_geom.has_step_rotation_or_scale:
            inst = fm.Transform(
                child=array_geom.child,
                translation=(tx, ty, tz),
                rotation_quat=q,
                scale=(sx, sy, sz),
            )
            mask |= _contains(inst, xx, yy, zz)
        else:
            mask |= _contains(array_geom.child, xx - tx, yy - ty, zz - tz)
    return mask


# ---------------------------------------------------------------------------
# 1. DSL, direction shortcuts, canonical indices, IR parity, and budgets
# ---------------------------------------------------------------------------


def test_array3d_dsl_direction_shortcuts_canonical_indices_and_ir_parity() -> None:
    dot = fm.Cylinder(radius=15e-9, height=10e-9, name="dot")
    arr = dot.array_3d(
        nx=4,
        ny=2,
        nz=3,
        dx=60e-9,
        dy=50e-9,
        dz=20e-9,
        direction=("-", "±", "+"),
    )
    assert isinstance(arr, Array3D)
    assert arr.total_instances == 24
    # Canonical index order: negative preserves [0, -1, -2, -3] for stable IDs
    assert arr.axes[0].direction == "negative"
    assert arr.axes[0].canonical_indices() == (0.0, -1.0, -2.0, -3.0)
    # Even symmetric N=2 -> (-0.5, +0.5)
    assert arr.axes[1].direction == "symmetric"
    assert arr.axes[1].canonical_indices() == (-0.5, 0.5)
    # Odd positive N=3 -> (0, 1, 2)
    assert arr.axes[2].direction == "positive"
    assert arr.axes[2].canonical_indices() == (0.0, 1.0, 2.0)

    # Shortcut "+-" maps to symmetric too
    arr_sym3 = dot.array_3d(nx=3, dx=50e-9, direction="+-")
    assert arr_sym3.axes[0].canonical_indices() == (-1.0, 0.0, 1.0)

    # 1:1 GeometryEntryIR::Array3D + remesh_cli roundtrip
    ir = arr.to_ir()
    assert ir["kind"] == "array_3d"
    assert ir["child"] == dot.to_ir()
    assert ir["merge_overlapping"] is False
    assert len(ir["axes"]) == 3
    assert [ax["axis"] for ax in ir["axes"]] == ["x", "y", "z"]
    assert _geometry_from_ir(ir).to_ir() == ir

    # fm.shapes.array_3d helper works seamlessly
    via_shapes = fm.shapes.array_3d(dot, nx=2, ny=2, dx=40e-9, dy=40e-9)
    assert isinstance(via_shapes, Array3D)
    assert via_shapes.total_instances == 4


def test_array3d_budget_and_validation_guards() -> None:
    box = fm.Box(10e-9, 10e-9, 10e-9)

    with pytest.raises(ValueError, match=str(MAX_ARRAY_AXIS_COUNT)):
        box.array_3d(nx=MAX_ARRAY_AXIS_COUNT + 1, dx=20e-9)

    with pytest.raises(ValueError, match=str(MAX_ARRAY_INSTANCES_FDM)):
        box.array_3d(nx=500, ny=500, dx=20e-9, dy=20e-9)

    with pytest.raises(ValueError, match="step_scale_factor"):
        box.array_3d(nx=2, dx=20e-9, step_scale=((-1.0, 1.0, 1.0), (1.0, 1.0, 1.0), (1.0, 1.0, 1.0)))

    with pytest.raises(ValueError, match="count must be an integer"):
        box.array_3d(nx=1.5)

    with pytest.raises(ValueError, match="count must be an integer"):
        box.array_3d(nx=True)

    # OCC limit (2500)
    too_many_occ = box.array_3d(nx=51, ny=50, dx=20e-9, dy=20e-9)  # 2550 > 2500
    assert too_many_occ.total_instances == 2550
    assert not is_occ_compatible([too_many_occ])


# ---------------------------------------------------------------------------
# 2. SceneDocument -> fluent Python .array_3d(...) -> ProblemIR roundtrip
# ---------------------------------------------------------------------------


def test_scene_document_antidot_array3d_roundtrip_without_loop_unrolling(
    tmp_path: Path,
) -> None:
    scene = _scene_with_geometry(
        name="antidot_lattice",
        geometry_kind="Difference",
        geometry_params={
            "operands": [
                {
                    "operand_id": "base_film",
                    "label": "Film",
                    "enabled": True,
                    "geometry": {
                        "geometry_kind": "Box",
                        "geometry_params": {"size": [600e-9, 600e-9, 10e-9]},
                    },
                },
                {
                    "operand_id": "hole_array",
                    "label": "4x4 Hole Lattice",
                    "enabled": True,
                    "geometry": {
                        "geometry_kind": "Array3D",
                        "geometry_params": {
                            "child": {
                                "geometry_kind": "Cylinder",
                                "geometry_params": {"radius": 20e-9, "height": 14e-9},
                            },
                            "axes": [
                                ArrayAxisSpec(
                                    axis="x",
                                    enabled=True,
                                    count=4,
                                    direction="symmetric",
                                    pitch_m=100e-9,
                                ).to_ir(),
                                ArrayAxisSpec(
                                    axis="y",
                                    enabled=True,
                                    count=4,
                                    direction="symmetric",
                                    pitch_m=100e-9,
                                ).to_ir(),
                                ArrayAxisSpec(axis="z", enabled=False, count=1).to_ir(),
                            ],
                            "merge_overlapping": False,
                        },
                    },
                },
            ]
        },
    )

    rendered = render_scene_document_as_script(scene)
    assert ".subtract(" in rendered
    assert ".array_3d(" in rendered
    assert "for " not in rendered  # Never unrolls loops!

    script_path = tmp_path / "antidot.py"
    script_path.write_text(rendered, encoding="utf-8")
    loaded = load_problem_from_script(script_path, lightweight_assets=True)
    ir_script = loaded.problem.to_ir(include_geometry_assets=False)["geometry"]["entries"][0]
    assert ir_script["kind"] == "difference"
    assert ir_script["tool"]["kind"] == "array_3d"
    assert ir_script["tool"]["axes"][0]["count"] == 4
    assert ir_script["tool"]["axes"][1]["count"] == 4
    assert ir_script["tool"]["axes"][0]["direction"] == "symmetric"

    ir_scene = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )["geometry"]["entries"][0]
    assert ir_scene["tool"]["kind"] == "array_3d"
    assert ir_scene["tool"]["axes"] == ir_script["tool"]["axes"]

    # Roundtrip back through builder draft -> SceneDocument -> ProblemIR
    rebuilt_scene = build_scene_document_from_builder(export_builder_draft(loaded))
    ir_rebuilt = scene_document_to_problem_ir(
        rebuilt_scene,
        requested_backend="fem",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )["geometry"]["entries"][0]
    assert ir_rebuilt["tool"]["axes"] == ir_script["tool"]["axes"]


# ---------------------------------------------------------------------------
# 3. Gmsh OCC realization & analytical volumes (antidots, dots, merge, limit)
# ---------------------------------------------------------------------------


def _occ_volume_m3(geometry: fm.model.geometry.Geometry) -> float:
    gmsh = pytest.importorskip("gmsh")
    scale = 1e6
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("etap_c_array3d_occ")
        tags = _add_geometry_to_occ(gmsh, geometry, scale=scale)
        gmsh.model.occ.synchronize()
        vol_tags = [(d, t) for d, t in tags if d == 3]
        assert vol_tags
        return sum(gmsh.model.occ.getMass(d, t) for d, t in vol_tags) / (scale ** 3)
    finally:
        gmsh.finalize()


def test_occ_array3d_dot_lattice_antidot_lattice_merge_and_limit() -> None:
    # 1. Disjoint 3x2 nanodot lattice
    dot = fm.Box(40e-9, 40e-9, 10e-9)
    dots = dot.array_3d(nx=3, ny=2, dx=80e-9, dy=80e-9)
    assert is_occ_compatible([dots])
    v_dot = 40e-9 * 40e-9 * 10e-9
    assert math.isclose(_occ_volume_m3(dots), 6.0 * v_dot, rel_tol=1e-4)

    # 2. Antidot lattice: Film - Array3D(Hole) (3x3 symmetric holes)
    film = fm.Box(500e-9, 500e-9, 10e-9)
    hole = fm.Cylinder(radius=25e-9, height=14e-9)
    holes = hole.array_3d(
        nx=3, ny=3, dx=120e-9, dy=120e-9, direction=("symmetric", "symmetric", "positive")
    )
    antidot = film.subtract(holes)
    assert is_occ_compatible([antidot])
    v_antidot_expected = 500e-9 * 500e-9 * 10e-9 - 9.0 * math.pi * (25e-9 ** 2) * 10e-9
    assert math.isclose(_occ_volume_m3(antidot), v_antidot_expected, rel_tol=1e-4)

    # 3. Overlapping array with merge_overlapping=True fuses cleanly without double-counting volume
    merged = dot.array_3d(nx=2, dx=20e-9, merge=True)
    assert math.isclose(_occ_volume_m3(merged), 60e-9 * 40e-9 * 10e-9, rel_tol=1e-4)

    # 4. Stepped scale array in OCC
    scaled_arr = dot.array_3d(
        nx=2,
        dx=100e-9,
        step_scale=((1.5, 1.0, 1.0), (1.0, 1.0, 1.0), (1.0, 1.0, 1.0)),
    )
    assert math.isclose(_occ_volume_m3(scaled_arr), v_dot * (1.0 + 1.5), rel_tol=1e-4)

    # 5. OCC hard limit enforcement (> 2500)
    gmsh = pytest.importorskip("gmsh")
    too_large = dot.array_3d(nx=51, ny=50, dx=80e-9, dy=80e-9)
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("etap_c_limit")
        with pytest.raises(ValueError, match="array_occ_instance_limit_exceeded"):
            _add_geometry_to_occ(gmsh, too_large, scale=1e6)
    finally:
        gmsh.finalize()


# ---------------------------------------------------------------------------
# 4. Surface preview for Array3D
# ---------------------------------------------------------------------------


def test_surface_preview_for_array3d() -> None:
    pytest.importorskip("trimesh")
    tile = fm.Box(30e-9, 30e-9, 10e-9)
    arr = tile.array_3d(nx=3, ny=2, dx=50e-9, dy=50e-9)
    payload = build_surface_preview_payload(arr)
    assert payload is not None
    # Box has 12 triangles -> 6 instances = 72 triangles = 216 facet node indices
    assert len(payload["facet_nodes"]) == 6 * 12 * 3


# ---------------------------------------------------------------------------
# 5. O(1 + K*C) Inverse Lattice Voxelizer vs Brute-Force Reference Loop
# ---------------------------------------------------------------------------


def _assert_inverse_matches_reference(
    array_geom: Array3D,
    cell_size: tuple[float, float, float],
) -> None:
    vox = voxelize_geometry(array_geom, cell_size)
    nz, ny, nx = vox.mask.shape
    dx, dy, dz = cell_size
    ox, oy, oz = vox.origin
    xs = ox + (np.arange(nx, dtype=np.float64) + 0.5) * dx
    ys = oy + (np.arange(ny, dtype=np.float64) + 0.5) * dy
    zs = oz + (np.arange(nz, dtype=np.float64) + 0.5) * dz
    xx_2d, yy_2d = np.meshgrid(xs, ys, indexing="xy")
    xx = np.broadcast_to(xx_2d[np.newaxis, :, :], (nz, ny, nx))
    yy = np.broadcast_to(yy_2d[np.newaxis, :, :], (nz, ny, nx))
    zz = np.broadcast_to(zs[:, np.newaxis, np.newaxis], (nz, ny, nx))

    ref = _reference_array3d_contains(array_geom, xx, yy, zz)
    assert np.array_equal(vox.mask, ref)


def test_voxelization_inverse_matches_reference_for_rect_hex_skew_sym_neg_and_antidot() -> None:
    cell = (4e-9, 4e-9, 4e-9)

    # 1. Rectangular 2D (N_z == 1 tests Gram-Schmidt orthonormal complement!)
    tile = fm.Box(16e-9, 16e-9, 8e-9)
    rect = tile.array_3d(nx=3, ny=2, dx=28e-9, dy=28e-9)
    _assert_inverse_matches_reference(rect, cell)

    # 2. Hexagonal / oblique Bravais lattice: dy = p * sqrt(3)/2, extra_x = p/2
    pitch = 32e-9
    hex_arr = fm.Cylinder(radius=10e-9, height=8e-9).array_3d(
        nx=3,
        ny=3,
        dx=pitch,
        dy=pitch * math.sqrt(3.0) / 2.0,
        extra_step=((0.0, 0.0, 0.0), (0.5 * pitch, 0.0, 0.0), (0.0, 0.0, 0.0)),
    )
    _assert_inverse_matches_reference(hex_arr, cell)

    # 3. Tight skewed basis from plan (a=(20nm, 0), b=(19nm, 20nm), child half-extent 9.5nm)
    skew_arr = fm.Box(19e-9, 19e-9, 8e-9).array_3d(
        nx=3,
        ny=3,
        dx=20e-9,
        dy=20e-9,
        extra_step=((0.0, 0.0, 0.0), (19e-9, 0.0, 0.0), (0.0, 0.0, 0.0)),
    )
    _assert_inverse_matches_reference(skew_arr, cell)

    # 4. Even symmetric 2x2x1
    sym_even = tile.array_3d(nx=2, ny=2, dx=28e-9, dy=28e-9, direction="symmetric")
    _assert_inverse_matches_reference(sym_even, cell)

    # 5. Negative direction 4x1x1 (exact [0, -1, -2, -3] placement)
    neg_1d = tile.array_3d(nx=4, dx=24e-9, direction="negative")
    _assert_inverse_matches_reference(neg_1d, cell)

    # 6. Bounding-box gap mode
    gap_arr = tile.array_3d(
        nx=3, ny=2, spacing_mode="bounding_box_gap", gap=(8e-9, 12e-9, 0.0)
    )
    _assert_inverse_matches_reference(gap_arr, cell)

    # 7. Non-centered child inside Subtract(Film, Array3D(Hole)) — verifies c_child handling!
    film = fm.Box(160e-9, 160e-9, 8e-9)
    off_center_hole = fm.Cylinder(radius=12e-9, height=12e-9).translate((14e-9, -10e-9, 0.0))
    hole_lattice = off_center_hole.array_3d(
        nx=3, ny=3, dx=44e-9, dy=44e-9, direction=("symmetric", "symmetric", "positive")
    )
    antidot = film.subtract(hole_lattice)
    vox_anti = voxelize_geometry(antidot, cell)
    nz, ny, nx = vox_anti.mask.shape
    ox, oy, oz = vox_anti.origin
    xs = ox + (np.arange(nx, dtype=np.float64) + 0.5) * cell[0]
    ys = oy + (np.arange(ny, dtype=np.float64) + 0.5) * cell[1]
    zs = oz + (np.arange(nz, dtype=np.float64) + 0.5) * cell[2]
    xx_2d, yy_2d = np.meshgrid(xs, ys, indexing="xy")
    xx = np.broadcast_to(xx_2d[np.newaxis, :, :], (nz, ny, nx))
    yy = np.broadcast_to(yy_2d[np.newaxis, :, :], (nz, ny, nx))
    zz = np.broadcast_to(zs[:, np.newaxis, np.newaxis], (nz, ny, nx))
    ref_anti = _contains(film, xx, yy, zz) & ~_reference_array3d_contains(hole_lattice, xx, yy, zz)
    assert np.array_equal(vox_anti.mask, ref_anti)
    assert int(vox_anti.mask.sum()) < int(voxelize_geometry(film, cell).mask.sum())

    # 8. Candidate budget guard when > 256 overlapping instances cover the same voxel
    dense_overlap = fm.Box(100e-9, 20e-9, 8e-9).array_3d(nx=300, dx=0.2e-9)
    with pytest.raises(ValueError, match="array_candidate_budget_exceeded"):
        voxelize_geometry(dense_overlap, cell)
