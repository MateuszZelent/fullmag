"""Tests for Task 3B: Meander, InductiveLoop, and PiecewisePath3D antenna topologies."""

from __future__ import annotations

import math

import pytest

import fullmag as fm
from fullmag.meshing._gmsh_occ import is_occ_compatible
from fullmag.model.geometry import (
    InductiveLoopLayout,
    MeanderAntennaLayout,
    Path3DWaypoint,
    PiecewisePath3DLayout,
)
from fullmag.runtime.script_builder import _export_geometry_descriptor, _render_geometry_expr


def test_meander_inductive_loop_and_piecewise_path_layouts_validate_and_serialize() -> None:
    # 1. MeanderAntennaLayout: valid geometry, non-self-intersection guard, IR & script roundtrip
    meander = MeanderAntennaLayout(
        name="meander_grating",
        length_m=2.0e-6,
        signal_width_m=100e-9,
        thickness_m=50e-9,
        conductivity_s_per_m=5.96e7,
        finger_count=4,
        pitch_m=300e-9,
        bend_radius_m=75e-9,  # 2*75 + 100 = 250 <= 300 -> valid
    )
    assert is_occ_compatible([meander])
    assert len(meander._sections()) >= 8
    bounds_min, bounds_max = meander.world_bounds()
    assert bounds_max[0] > bounds_min[0]
    assert bounds_max[1] > bounds_min[1]
    assert math.isclose(bounds_max[2] - bounds_min[2], 50e-9, rel_tol=1e-9)

    meander_ir = meander.to_ir()
    assert meander_ir["kind"] == "meander"
    assert MeanderAntennaLayout.from_ir(meander_ir).to_ir() == meander_ir

    meander_expr = _render_geometry_expr(meander, magnet_name="meander_grating", source_root=fm.Path(".") if hasattr(fm, "Path") else __import__("pathlib").Path("."))
    assert meander_expr.startswith("fm.MeanderAntennaLayout(")
    rebuilt_meander = eval(meander_expr, {"fm": fm})
    assert isinstance(rebuilt_meander, MeanderAntennaLayout)
    assert rebuilt_meander.finger_count == 4
    assert math.isclose(rebuilt_meander.pitch_m, 300e-9, rel_tol=1e-12)

    # Self-intersecting meander bend: 2 * bend_radius + width > pitch MUST fail
    with pytest.raises(ValueError, match="bend_radius"):
        MeanderAntennaLayout(
            name="bad_meander",
            length_m=2.0e-6,
            signal_width_m=100e-9,
            thickness_m=50e-9,
            conductivity_s_per_m=5.96e7,
            finger_count=4,
            pitch_m=200e-9,
            bend_radius_m=60e-9,  # 2*60 + 100 = 220 > 200 -> invalid!
        )

    # 2. InductiveLoopLayout: circular, rectangular, omega
    for shape in ("circular", "rectangular", "omega"):
        loop = InductiveLoopLayout(
            name=f"loop_{shape}",
            loop_shape=shape,
            inner_radius_m=250e-9,
            signal_width_m=80e-9,
            thickness_m=40e-9,
            conductivity_s_per_m=5.96e7,
            turns=1,
            bend_radius_m=40e-9 if shape == "rectangular" else 0.0,
        )
        assert is_occ_compatible([loop])
        assert len(loop._sections()) >= 4
        ir = loop.to_ir()
        assert ir["kind"] == "inductive_loop"
        assert ir["loop_shape"] == shape
        assert InductiveLoopLayout.from_ir(ir).to_ir() == ir

        desc = _export_geometry_descriptor(loop, flatten_translation=True)
        assert desc["geometry_kind"] == "InductiveLoopLayout"
        expr = _render_geometry_expr(loop, magnet_name=loop.name, source_root=__import__("pathlib").Path("."))
        assert expr.startswith("fm.InductiveLoopLayout(")
        rebuilt = eval(expr, {"fm": fm})
        assert isinstance(rebuilt, InductiveLoopLayout)
        assert rebuilt.loop_shape == shape

    with pytest.raises(ValueError, match="loop_shape"):
        InductiveLoopLayout(
            name="bad_loop",
            loop_shape="triangular",  # type: ignore[arg-type]
            inner_radius_m=250e-9,
            signal_width_m=80e-9,
            thickness_m=40e-9,
            conductivity_s_per_m=5.96e7,
        )

    # 3. PiecewisePath3DLayout: 3D air-bridge path, distinct waypoints guard, roundtrip
    path3d = PiecewisePath3DLayout(
        name="air_bridge",
        waypoints=(
            Path3DWaypoint(0.0, 0.0, 0.0),
            Path3DWaypoint(0.0, 0.0, 120e-9, bend_radius_m=20e-9),
            Path3DWaypoint(500e-9, 0.0, 120e-9, bend_radius_m=20e-9),
            Path3DWaypoint(500e-9, 0.0, 0.0),
        ),
        signal_width_m=100e-9,
        thickness_m=40e-9,
        conductivity_s_per_m=5.96e7,
    )
    assert is_occ_compatible([path3d])
    assert len(path3d._sections()) >= 4
    p_min, p_max = path3d.world_bounds()
    assert p_max[2] > 100e-9
    path_ir = path3d.to_ir()
    assert path_ir["kind"] == "piecewise_3d_path"
    assert PiecewisePath3DLayout.from_ir(path_ir).to_ir() == path_ir

    path_expr = _render_geometry_expr(path3d, magnet_name="air_bridge", source_root=__import__("pathlib").Path("."))
    assert path_expr.startswith("fm.PiecewisePath3DLayout(")
    rebuilt_path = eval(path_expr, {"fm": fm})
    assert isinstance(rebuilt_path, PiecewisePath3DLayout)
    assert len(rebuilt_path.waypoints) == 4

    # Fewer than 2 waypoints or duplicate consecutive waypoints MUST fail
    with pytest.raises(ValueError, match="waypoint"):
        PiecewisePath3DLayout(
            name="too_short",
            waypoints=(Path3DWaypoint(0.0, 0.0, 0.0),),
            signal_width_m=100e-9,
            thickness_m=40e-9,
            conductivity_s_per_m=5.96e7,
        )
    with pytest.raises(ValueError, match="distinct"):
        PiecewisePath3DLayout(
            name="duplicate_pt",
            waypoints=(Path3DWaypoint(0.0, 0.0, 0.0), Path3DWaypoint(0.0, 0.0, 0.0)),
            signal_width_m=100e-9,
            thickness_m=40e-9,
            conductivity_s_per_m=5.96e7,
        )
