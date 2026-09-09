import math
from unittest.mock import patch

import pytest

import fullmag as fm
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import _render_shape_expression


def _cpw_stations() -> tuple[fm.CPWWidthStation, ...]:
    return (
        fm.CPWWidthStation.symmetric(
            s=0.0, signal_width=2.0e-6, gap=1.0e-6, ground_width=4.0e-6
        ),
        fm.CPWWidthStation(
            s=0.48,
            signal_width_m=0.2e-6,
            left_gap_m=0.25e-6,
            right_gap_m=0.3e-6,
            left_ground_width_m=1.2e-6,
            right_ground_width_m=1.4e-6,
        ),
        fm.CPWWidthStation.symmetric(
            s=1.0, signal_width=2.0e-6, gap=1.0e-6, ground_width=4.0e-6
        ),
    )


def test_variable_width_cpw_serializes_asymmetric_stations_and_terminal_faces() -> None:
    layout = fm.CPWAntennaLayout(
        name="cpw_constriction",
        length=12.0e-6,
        thickness=120.0e-9,
        conductivity=58.0e6,
        stations=_cpw_stations(),
    )

    ir = layout.to_ir()

    assert ir["kind"] == "cpw"
    assert [station["s"] for station in ir["stations"]] == [0.0, 0.48, 1.0]
    assert ir["stations"][1]["left_gap_m"] != ir["stations"][1]["right_gap_m"]
    assert set(layout.conductor_part_ids) == {"signal", "ground_left", "ground_right"}
    assert all(area > 0.0 for area in layout.end_face_areas_m2.values())
    assert len(layout.solid_segments()) == 2


def test_cpw_round_trip_preserves_station_parameters_and_transform() -> None:
    layout = fm.CPWAntennaLayout(
        name="cpw",
        length_m=12.0e-6,
        thickness_m=120.0e-9,
        conductivity_s_per_m=58.0e6,
        stations=_cpw_stations(),
        transform=fm.RigidTransform(
            rotation=((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
            translation=(3.0e-6, -2.0e-6, 5.0e-6),
        ),
    )

    rebuilt = fm.CPWAntennaLayout.from_ir(layout.to_ir())

    assert rebuilt == layout
    lower, upper = layout.world_bounds()
    assert math.isclose(lower[0], -3.0e-6, abs_tol=1e-15)
    assert math.isclose(upper[0], 9.0e-6, abs_tol=1e-15)
    assert upper[1] > lower[1]
    assert lower[2] < upper[2]


def test_microstrip_requires_explicit_return_and_has_positive_end_faces() -> None:
    stations = (
        fm.MicrostripWidthStation(s=0.0, signal_width=1.0e-6),
        fm.MicrostripWidthStation(s=1.0, signal_width=0.4e-6),
    )
    with pytest.raises(TypeError, match="return_width_m"):
        fm.MicrostripAntennaLayout(
            name="missing_return",
            length=8.0e-6,
            thickness=100.0e-9,
            conductivity=58.0e6,
            stations=stations,
        )

    layout = fm.MicrostripAntennaLayout(
        name="microstrip",
        length=8.0e-6,
        thickness=100.0e-9,
        conductivity=58.0e6,
        stations=stations,
        return_width=4.0e-6,
        signal_part_id="trace",
        return_part_id="plane",
    )
    assert layout.to_ir()["kind"] == "microstrip"
    assert set(layout.conductor_part_ids) == {"trace", "plane"}
    assert all(area > 0.0 for area in layout.end_face_areas_m2.values())
    rebuilt = fm.MicrostripAntennaLayout.from_ir(layout.to_ir())
    assert rebuilt == layout
    assert layout.to_ir()["terminal_faces"]["plane"]["outlet"] == "local_u_max"


@pytest.mark.parametrize(
    "stations, message",
    [
        (
            (
                fm.CPWWidthStation.symmetric(
                    s=0.1, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
                fm.CPWWidthStation.symmetric(
                    s=1.0, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
            ),
            "start at s=0",
        ),
        (
            (
                fm.CPWWidthStation.symmetric(
                    s=0.0, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
                fm.CPWWidthStation.symmetric(
                    s=0.8, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
            ),
            "end at s=1",
        ),
        (
            (
                fm.CPWWidthStation.symmetric(
                    s=0.0, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
                fm.CPWWidthStation.symmetric(
                    s=0.7, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
                fm.CPWWidthStation.symmetric(
                    s=0.7, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
                fm.CPWWidthStation.symmetric(
                    s=1.0, signal_width=1e-6, gap=1e-6, ground_width=1e-6
                ),
            ),
            "strictly increasing",
        ),
    ],
)
def test_cpw_layout_rejects_invalid_station_domain(stations, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        fm.CPWAntennaLayout(
            name="invalid",
            length=1.0e-6,
            thickness=10.0e-9,
            conductivity=58.0e6,
            stations=stations,
        )


def test_station_rejects_nonfinite_and_nonpositive_dimensions() -> None:
    with pytest.raises(ValueError, match="finite"):
        fm.CPWWidthStation.symmetric(
            s=math.nan, signal_width=1.0e-6, gap=1.0e-6, ground_width=1.0e-6
        )
    with pytest.raises(ValueError, match="positive"):
        fm.MicrostripWidthStation(s=0.0, signal_width_m=0.0)


def test_rigid_transform_rejects_reflection_and_preserves_identity() -> None:
    assert fm.RigidTransform.identity().apply((1.0, 2.0, 3.0)) == (1.0, 2.0, 3.0)
    with pytest.raises(ValueError, match="determinant"):
        fm.RigidTransform(rotation=((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))
    with pytest.raises(ValueError, match="finite"):
        fm.RigidTransform(translation=(math.nan, 0.0, 0.0))


def test_scene_builder_round_trip_keeps_editable_antenna_stations() -> None:
    layout = fm.CPWAntennaLayout(
        name="editable_cpw",
        length_m=10.0e-6,
        thickness_m=100.0e-9,
        conductivity_s_per_m=58.0e6,
        stations=_cpw_stations(),
    )
    payload = layout.to_ir()
    builder = {
        "revision": 4,
        "backend": "fem",
        "geometries": [
            {
                "name": layout.geometry_name,
                "object_id": "antenna-object-1",
                "role": "antenna",
                "geometry_kind": type(layout).__name__,
                "geometry_params": {
                    key: value for key, value in payload.items() if key not in {"name", "kind"}
                },
            }
        ],
    }

    scene = build_scene_document_from_builder(builder)
    rebuilt = build_builder_from_scene_document(scene)
    rebuilt_geometry = rebuilt["geometries"][0]
    assert rebuilt_geometry["geometry_kind"] == "CPWAntennaLayout"
    assert rebuilt_geometry["geometry_params"]["stations"][1]["signal_width_m"] == pytest.approx(
        0.2e-6
    )

    source = _render_shape_expression(rebuilt_geometry)
    assert "fm.CPWAntennaLayout" in source
    assert "fm.CPWWidthStation" in source
    namespace = {"fm": fm}
    rebuilt_layout = eval(source, namespace, {})
    assert rebuilt_layout == layout


def test_layout_exposes_a_finite_preview_mesh_for_all_conductor_parts() -> None:
    trimesh = pytest.importorskip("trimesh")
    from fullmag.meshing.surface_assets import _geometry_to_trimesh

    layout = fm.CPWAntennaLayout(
        name="preview_cpw",
        length_m=4.0e-6,
        thickness_m=80.0e-9,
        conductivity_s_per_m=58.0e6,
        stations=_cpw_stations(),
        transform=fm.RigidTransform(translation=(2.0e-6, -1.0e-6, 3.0e-6)),
    )

    mesh = _geometry_to_trimesh(layout, trimesh)

    assert len(mesh.vertices) == 12 * len(layout.stations)
    assert len(mesh.faces) > 0
    assert all(math.isfinite(float(value)) for value in mesh.vertices.reshape(-1))
    assert tuple(mesh.bounds[0]) == pytest.approx(layout.world_bounds()[0])
    assert tuple(mesh.bounds[1]) == pytest.approx(layout.world_bounds()[1])


def test_layout_is_not_voxelized_as_a_magnetic_fdm_body() -> None:
    from fullmag.model.problem import build_geometry_assets_for_request

    layout = fm.CPWAntennaLayout(
        name="fdm_excluded_cpw",
        length_m=2.0e-6,
        thickness_m=50.0e-9,
        conductivity_s_per_m=58.0e6,
        stations=(
            fm.CPWWidthStation.symmetric(
                s=0.0, signal_width=0.5e-6, gap=0.2e-6, ground_width=0.5e-6
            ),
            fm.CPWWidthStation.symmetric(
                s=1.0, signal_width=0.5e-6, gap=0.2e-6, ground_width=0.5e-6
            ),
        ),
    )
    hints = fm.DiscretizationHints(fdm=fm.FDM(cell=(0.1e-6, 0.1e-6, 0.1e-6)))
    universe = {"mode": "manual", "size": [4.0e-6, 4.0e-6, 2.0e-6]}

    with patch("fullmag.meshing.realize_fdm_grid_asset") as realize:
        assets = build_geometry_assets_for_request(
            requested_backend=fm.BackendTarget.FDM,
            geometries=(layout,),
            discretization=hints,
            study_universe=universe,
        )

    assert assets is None
    realize.assert_not_called()
