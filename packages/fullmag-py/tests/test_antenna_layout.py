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


def test_layout_uses_native_occ_for_shared_fem_domains() -> None:
    from fullmag.meshing._gmsh_occ import is_occ_compatible

    layout = fm.MicrostripAntennaLayout(
        name="occ_microstrip",
        length_m=2.0e-6,
        thickness_m=50.0e-9,
        conductivity_s_per_m=58.0e6,
        stations=(
            fm.MicrostripWidthStation(s=0.0, signal_width_m=0.5e-6),
            fm.MicrostripWidthStation(s=1.0, signal_width_m=0.5e-6),
        ),
        return_width_m=0.5e-6,
    )

    assert is_occ_compatible([layout]) is True


def test_independent_layout_mesh_publishes_stable_terminal_markers() -> None:
    from fullmag.meshing import generate_mesh
    from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker

    assert antenna_terminal_marker("antenna", "signal", "local_u_min") == 117_762_299

    layout = fm.MicrostripAntennaLayout(
        name="marked_microstrip",
        length_m=6.0e-6,
        thickness_m=100.0e-9,
        conductivity_s_per_m=58.0e6,
        stations=(
            fm.MicrostripWidthStation(s=0.0, signal_width_m=1.0e-6),
            fm.MicrostripWidthStation(s=1.0, signal_width_m=1.0e-6),
        ),
        return_width_m=2.0e-6,
        return_offset_m=200.0e-9,
    )

    mesh = generate_mesh(layout, maximum_element_size=1.5e-6)
    observed = {int(marker) for marker in mesh.boundary_markers}
    expected = {
        antenna_terminal_marker(layout.geometry_name, part_id, selector)
        for part_id in layout.conductor_part_ids
        for selector in ("local_u_min", "local_u_max")
    }

    assert expected <= observed


def test_fem_mesh_cache_follows_canonical_cache_root(monkeypatch) -> None:
    from pathlib import Path

    from fullmag.model.problem import _fem_mesh_cache_dir

    canonical_cache = Path("D:/git/fullmag/storage/cache/windows/antenna-test")
    monkeypatch.delenv("FULLMAG_FEM_MESH_CACHE_DIR", raising=False)
    monkeypatch.setenv("FULLMAG_CACHE_ROOT", str(canonical_cache))

    with patch.object(Path, "mkdir") as mkdir:
        resolved = _fem_mesh_cache_dir()

    assert resolved == canonical_cache / "fem_mesh_assets"
    mkdir.assert_called_once_with(parents=True, exist_ok=True)


def test_independent_terminal_markers_follow_owner_not_name() -> None:
    from fullmag.meshing import generate_mesh
    from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker

    expected = {
        antenna_terminal_marker("immutable-antenna", part, selector)
        for part in ("signal", "return")
        for selector in ("local_u_min", "local_u_max")
    }
    for name, transform in (
        ("original", fm.RigidTransform.identity()),
        ("renamed", fm.RigidTransform(
            rotation=((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
            translation=(3e-6, -2e-6, 5e-6),
        )),
    ):
        layout = fm.MicrostripAntennaLayout(
            name=name, length_m=6e-6, thickness_m=100e-9,
            conductivity_s_per_m=58e6,
            stations=(fm.MicrostripWidthStation(s=0, signal_width_m=1e-6),
                      fm.MicrostripWidthStation(s=1, signal_width_m=0.8e-6)),
            return_width_m=2e-6, return_offset_m=200e-9,
            transform=transform,
        )
        mesh = generate_mesh(layout, maximum_element_size=1.5e-6,
                             object_id="immutable-antenna")
        assert {int(value) for value in mesh.boundary_markers if int(value) != 1} == expected
        axis = [transform.rotation_matrix[row][0] for row in range(3)]
        for selector, target in (("local_u_min", 0.0), ("local_u_max", layout.length_m)):
            for part in layout.conductor_part_ids:
                marker = antenna_terminal_marker("immutable-antenna", part, selector)
                for ordinal, observed in enumerate(mesh.boundary_markers):
                    if int(observed) != marker:
                        continue
                    nodes = mesh.facet_nodes[mesh.facet_offsets[ordinal]:mesh.facet_offsets[ordinal + 1]]
                    for node in mesh.nodes[nodes]:
                        projection = sum((node[i] - transform.translation_m[i]) * axis[i] for i in range(3))
                        assert projection == pytest.approx(target, abs=1e-14)


def test_geometry_asset_caches_and_realizer_preserve_owner(monkeypatch, tmp_path) -> None:
    from fullmag.model.problem import build_geometry_assets_for_request, _fem_mesh_cache_key
    from fullmag.meshing import generate_mesh

    layout = fm.MicrostripAntennaLayout(
        name="cached", length_m=6e-6, thickness_m=100e-9,
        conductivity_s_per_m=58e6,
        stations=(fm.MicrostripWidthStation(s=0, signal_width_m=1e-6),
                  fm.MicrostripWidthStation(s=1, signal_width_m=1e-6)),
        return_width_m=2e-6, return_offset_m=200e-9,
    )
    hints = fm.FEM(order=1, maximum_element_size=1.5e-6)
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR", str(tmp_path))
    cache = {}
    calls = []
    def record_mesh(*args, **kwargs):
        calls.append(kwargs.get("object_id"))
        return generate_mesh(*args, **kwargs)
    with patch("fullmag.meshing.asset_pipeline.generate_mesh", side_effect=record_mesh):
        for owner in ("owner-a", "owner-b", "owner-a"):
            build_geometry_assets_for_request(
                requested_backend=fm.BackendTarget.FEM, geometries=(layout,),
                discretization=fm.DiscretizationHints(fem=hints),
                geometry_object_ids={layout.geometry_name: owner}, asset_cache=cache,
            )
        assert len(cache) == 2
        cache.clear()
        build_geometry_assets_for_request(
            requested_backend=fm.BackendTarget.FEM, geometries=(layout,),
            discretization=fm.DiscretizationHints(fem=hints),
            geometry_object_ids={layout.geometry_name: "owner-a"}, asset_cache=cache,
        )
    assert calls == ["owner-a", "owner-b"]
    assert len(cache) == 1
    assert len(list(tmp_path.glob("*.npz"))) == 2
    assert _fem_mesh_cache_key(layout, hints, object_id="owner-a") != _fem_mesh_cache_key(
        layout, hints, object_id="owner-b")


def test_problem_mesh_callers_pass_authored_geometry_owners() -> None:
    magnet = fm.Ferromagnet(
        name="magnet-name", object_id="magnet-id", geometry=fm.Box(1e-6, 1e-6, 1e-6),
        material=fm.Material(name="material", Ms=800e3, A=13e-12, alpha=0.01),
    )
    auxiliary = fm.Box(2e-6, 1e-6, 1e-6, name="conductor-name")
    problem = fm.Problem(
        name="owner-test", magnets=(magnet,), energy=(fm.Exchange(),),
        study=fm.Relaxation(outputs=(), algorithm="projected_gradient_bb"),
        discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, maximum_element_size=1e-6)),
        auxiliary_geometries=(auxiliary,), auxiliary_geometry_roles={"conductor-name": "conductor"},
        auxiliary_geometry_object_ids={"conductor-name": "conductor-id"},
    )
    expected = {magnet.geometry.geometry_name: "magnet-id", "conductor-name": "conductor-id"}
    with patch("fullmag.model.problem.build_geometry_assets_for_request", return_value=None) as build:
        problem.to_ir()
        assert build.call_args.kwargs["geometry_object_ids"] == expected
        problem._build_geometry_assets(
            requested_backend=fm.BackendTarget.FEM,
            geometries=(magnet.geometry, auxiliary), discretization=problem.discretization,
        )
        assert build.call_args.kwargs["geometry_object_ids"] == expected


def test_explicit_world_mesh_uses_resolved_geometry_owner() -> None:
    from types import SimpleNamespace
    import fullmag.world as world

    resolved = fm.Box(1e-6, 1e-6, 1e-6, name="magnet-name_geom")
    handle = SimpleNamespace(
        _name="magnet-name", object_id="magnet-id", _object_regions=(),
        _resolved_geometry=lambda: resolved,
    )
    state = SimpleNamespace(
        _active_mesh_artifact=None, _cell=None, _study_universe=None,
        _auxiliary_geometry_object_ids={"conductor-name": "conductor-id"},
        _magnets=[handle], _geometry_asset_cache={},
    )
    class CapturedMeshRequest(Exception):
        pass
    with patch.object(world, "_state", state), \
         patch.object(world, "_collect_flat_geometries", return_value=[resolved]), \
         patch.object(world, "_resolve_flat_fem_hint", return_value=fm.FEM(order=1, maximum_element_size=1e-6)), \
         patch.object(world, "_mesh_source_root", return_value=None), \
         patch.object(world, "_collect_mesh_workflow_metadata", return_value=None), \
         patch.object(world, "build_geometry_assets_for_request", side_effect=CapturedMeshRequest) as build:
        with pytest.raises(CapturedMeshRequest):
            world._build_explicit_mesh_assets()
    assert build.call_args.kwargs["geometry_object_ids"] == {
        "magnet-name_geom": "magnet-id", "conductor-name": "conductor-id",
    }
