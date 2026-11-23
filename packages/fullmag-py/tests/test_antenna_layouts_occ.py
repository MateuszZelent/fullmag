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


def _quad_centroid(quad: object) -> tuple[float, float, float]:
    pts = list(quad)  # type: ignore[call-overload]
    return (
        0.25 * sum(float(p[0]) for p in pts),
        0.25 * sum(float(p[1]) for p in pts),
        0.25 * sum(float(p[2]) for p in pts),
    )


def _terminal_face_centroid(mesh: object, marker: int) -> tuple[float, float, float]:
    import numpy as np

    nodes = np.asarray(mesh.nodes, dtype=np.float64)  # type: ignore[attr-defined]
    faces = np.asarray(mesh.boundary_faces, dtype=np.int64)  # type: ignore[attr-defined]
    markers = np.asarray(mesh.boundary_markers, dtype=np.int64)  # type: ignore[attr-defined]
    selected = faces[markers == marker]
    assert selected.shape[0] >= 2, f"expected >=2 triangles on terminal {marker}, got {selected.shape[0]}"
    tri_pts = nodes[selected]
    v1 = tri_pts[:, 1] - tri_pts[:, 0]
    v2 = tri_pts[:, 2] - tri_pts[:, 0]
    areas = 0.5 * np.linalg.norm(np.cross(v1, v2), axis=1)
    total_area = float(np.sum(areas))
    assert total_area > 0.0
    centers = np.mean(tri_pts, axis=1)
    weighted = np.sum(centers * areas[:, None], axis=0) / total_area
    return (float(weighted[0]), float(weighted[1]), float(weighted[2]))


def test_occ_meshing_publishes_accurate_terminals_for_meander_loop_and_path3d() -> None:
    pytest.importorskip("gmsh")
    from fullmag.meshing import generate_mesh
    from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker

    tilted_transform = fm.RigidTransform(
        rotation=((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
        translation=(250e-9, -150e-9, 80e-9),
    )

    cases = [
        # Even finger_count=4: both inlet and outlet lie on local u = -L/2!
        (
            MeanderAntennaLayout(
                name="meander_even_4",
                length_m=1.2e-6,
                signal_width_m=100e-9,
                thickness_m=50e-9,
                conductivity_s_per_m=5.96e7,
                finger_count=4,
                pitch_m=300e-9,
                bend_radius_m=60e-9,
                transform=tilted_transform,
            ),
            120e-9,
        ),
        # Odd finger_count=3: inlet on -L/2, outlet on +L/2
        (
            MeanderAntennaLayout(
                name="meander_odd_3",
                length_m=1.0e-6,
                signal_width_m=100e-9,
                thickness_m=50e-9,
                conductivity_s_per_m=5.96e7,
                finger_count=3,
                pitch_m=280e-9,
                bend_radius_m=0.0,
            ),
            120e-9,
        ),
        # Circular, rectangular, and omega inductive loops
        (
            InductiveLoopLayout(
                name="loop_circular",
                loop_shape="circular",
                inner_radius_m=250e-9,
                signal_width_m=80e-9,
                thickness_m=40e-9,
                conductivity_s_per_m=5.96e7,
                turns=1,
            ),
            100e-9,
        ),
        (
            InductiveLoopLayout(
                name="loop_rectangular",
                loop_shape="rectangular",
                inner_radius_m=250e-9,
                signal_width_m=80e-9,
                thickness_m=40e-9,
                conductivity_s_per_m=5.96e7,
                turns=1,
                bend_radius_m=40e-9,
                transform=tilted_transform,
            ),
            100e-9,
        ),
        (
            InductiveLoopLayout(
                name="loop_omega",
                loop_shape="omega",
                inner_radius_m=250e-9,
                signal_width_m=80e-9,
                thickness_m=40e-9,
                conductivity_s_per_m=5.96e7,
                turns=1,
            ),
            100e-9,
        ),
        # 3D air-bridge path with vertical Z risers (caps in z=0 plane) and non-self-intersecting bends
        (
            PiecewisePath3DLayout(
                name="air_bridge_vertical_3d",
                waypoints=(
                    Path3DWaypoint(0.0, 0.0, 0.0, width_m=100e-9),
                    Path3DWaypoint(0.0, 0.0, 260e-9, bend_radius_m=75e-9),
                    Path3DWaypoint(500e-9, 0.0, 260e-9, bend_radius_m=75e-9),
                    Path3DWaypoint(500e-9, 0.0, 0.0, width_m=80e-9),
                ),
                signal_width_m=100e-9,
                thickness_m=40e-9,
                conductivity_s_per_m=5.96e7,
                transform=tilted_transform,
            ),
            100e-9,
        ),
        # Ramped 3D air-bridge with oblique 3D terminal cap normals
        (
            PiecewisePath3DLayout(
                name="air_bridge_ramped_3d",
                waypoints=(
                    Path3DWaypoint(0.0, 0.0, 0.0, width_m=120e-9),
                    Path3DWaypoint(100e-9, 0.0, 120e-9, bend_radius_m=25e-9),
                    Path3DWaypoint(400e-9, 0.0, 120e-9, bend_radius_m=25e-9),
                    Path3DWaypoint(500e-9, 0.0, 0.0, width_m=80e-9),
                ),
                signal_width_m=100e-9,
                thickness_m=40e-9,
                conductivity_s_per_m=5.96e7,
            ),
            100e-9,
        ),
    ]

    for layout, hmax in cases:
        mesh = generate_mesh(layout, maximum_element_size=hmax)
        assert mesh.n_nodes > 0
        assert mesh.n_elements > 0

        sections = layout._sections()
        expected_inlet = _quad_centroid(sections[0]["conductors"]["signal"])
        expected_outlet = _quad_centroid(sections[-1]["conductors"]["signal"])

        inlet_marker = antenna_terminal_marker(layout.geometry_name, "signal", "local_u_min")
        outlet_marker = antenna_terminal_marker(layout.geometry_name, "signal", "local_u_max")
        assert inlet_marker != outlet_marker

        observed = {int(m) for m in mesh.boundary_markers}
        assert inlet_marker in observed, f"{layout.geometry_name} missing inlet marker"
        assert outlet_marker in observed, f"{layout.geometry_name} missing outlet marker"
        assert 1 in observed, f"{layout.geometry_name} missing lateral surface marker 1"

        actual_inlet = _terminal_face_centroid(mesh, inlet_marker)
        actual_outlet = _terminal_face_centroid(mesh, outlet_marker)
        assert math.dist(actual_inlet, expected_inlet) < 1e-12, (
            f"{layout.geometry_name} inlet centroid {actual_inlet} != {expected_inlet}"
        )
        assert math.dist(actual_outlet, expected_outlet) < 1e-12, (
            f"{layout.geometry_name} outlet centroid {actual_outlet} != {expected_outlet}"
        )
