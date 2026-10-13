from __future__ import annotations

from uuid import uuid4

import numpy as np
import pytest

from fullmag.meshing import _gmsh_layered_box as layered_box
from fullmag.meshing._gmsh_types import MeshOptions


class _FakeMesh:
    def __init__(self, caps, periodic_nodes=None):
        self.caps = caps
        self.periodic_nodes = periodic_nodes or {}

    def getNodes(self, dim, tag, *, includeBoundary, returnParametricCoord):
        assert dim == 2
        assert includeBoundary is True
        assert returnParametricCoord is False
        tags, coordinates = self.caps[tag]
        return np.asarray(tags, dtype=np.uint64), np.asarray(coordinates, dtype=np.float64).reshape(-1), np.asarray([])

    def getPeriodicNodes(self, dim, slave_tag):
        assert dim == 2
        return self.periodic_nodes[slave_tag]


class _FakeModel:
    def __init__(self, mesh):
        self.mesh = mesh


class _FakeGmsh:
    def __init__(self, caps, periodic_nodes=None):
        self.model = _FakeModel(_FakeMesh(caps, periodic_nodes))


def _cap_rows(*, duplicate_first=False):
    bottom_tags = [1, 2, 3, 4]
    bottom_points = [
        (0.0, 0.0, 0.0),
        (10.0, 0.0, 0.0),
        (10.0, 10.0, 0.0),
        (0.0, 10.0, 0.0),
    ]
    if duplicate_first:
        bottom_tags.append(1)
        bottom_points.append(bottom_points[0])
    return {
        11: (bottom_tags, bottom_points),
        12: (
            [5, 6, 7, 8],
            [
                (0.0, 0.0, 20.0),
                (10.0, 0.0, 20.0),
                (10.0, 10.0, 20.0),
                (0.0, 10.0, 20.0),
            ],
        ),
    }


def _periodic_spec():
    return {
        "pair_id": "box-x",
        "marker_a": 31,
        "marker_b": 32,
        "master_tag": 101,
        "slave_tag": 201,
        "axis_hint": "x",
        "translation": [10.0, 0.0, 0.0],
        "tolerance_m": 0.1,
    }


def _patch_shared_builders(monkeypatch, *, scopes=None):
    captured = {}

    def fake_build(nodes, planes, bounds, **kwargs):
        captured.update(
            nodes=np.asarray(nodes).copy(),
            planes=np.asarray(planes).copy(),
            bounds=bounds,
            **kwargs,
        )
        return object()

    monkeypatch.setattr(layered_box, "build_layered_box_mesh_data", fake_build)
    if scopes is not None:
        monkeypatch.setattr(
            layered_box,
            "periodic_patch_z_bounds_from_gmsh",
            lambda gmsh, specs, **kwargs: scopes,
        )
    return captured


def _build_fake(gmsh, *, periodic_specs=(), **overrides):
    values = {
        "cap_surface_tags": [11, 12],
        "requested_layer_planes_si_m": [0.0, 2.0],
        "magnetic_plane_indices": (0, 1),
        "bounds_xy_si_m": (0.0, 1.0, 0.0, 1.0),
        "gmsh_units_per_m": 10.0,
        "options": MeshOptions(compute_quality=False),
        "periodic_surface_specs": list(periodic_specs),
        "outer_boundary_marker": 7,
    }
    values.update(overrides)
    return layered_box.build_layered_box_from_gmsh_caps(gmsh, **values)


def test_cap_nodes_join_by_tag_and_use_actual_si_planes(monkeypatch):
    captured = _patch_shared_builders(monkeypatch)
    gmsh = _FakeGmsh(_cap_rows(duplicate_first=True))

    result = _build_fake(
        gmsh,
        requested_layer_planes_si_m=[-5.0e-16, 2.0 + 5.0e-16],
    )

    assert result is not None
    assert captured["nodes"].shape == (8, 3)
    np.testing.assert_array_equal(captured["nodes"][:, 2], [0.0] * 4 + [2.0] * 4)
    np.testing.assert_array_equal(captured["planes"], [0.0, 2.0])
    assert captured["bounds"] == (0.0, 1.0, 0.0, 1.0)
    assert captured["magnetic_z_bounds"] == (0.0, 2.0)
    assert captured["outer_boundary_marker"] == 7
    assert captured["tetrahedralization_method"] == "delaunay"


def test_conflicting_coordinates_for_one_gmsh_node_tag_are_rejected(monkeypatch):
    _patch_shared_builders(monkeypatch)
    caps = _cap_rows(duplicate_first=True)
    tags, points = caps[11]
    points[-1] = (1.0, 0.0, 0.0)
    gmsh = _FakeGmsh(caps)

    with pytest.raises(ValueError, match="tag 1.*conflicting coordinates"):
        _build_fake(gmsh)


def test_cap_drift_beyond_existing_exact_layer_tolerance_is_rejected(monkeypatch):
    _patch_shared_builders(monkeypatch)
    caps = _cap_rows()
    tags, points = caps[12]
    caps[12] = (tags, [(x, y, z + 1.0e-5) for x, y, z in points])

    with pytest.raises(ValueError, match="requested layer plane"):
        _build_fake(_FakeGmsh(caps))


def test_periodic_pairs_drop_only_complete_off_cap_correspondences(monkeypatch):
    scopes = {("box-x", 31, 32): (0.0, 2.0)}
    captured = _patch_shared_builders(monkeypatch, scopes=scopes)
    spec = _periodic_spec()
    gmsh = _FakeGmsh(
        _cap_rows(),
        {
            201: (
                101,
                np.asarray([2, 900], dtype=np.uint64),
                np.asarray([1, 901], dtype=np.uint64),
                np.asarray([]),
            )
        },
    )

    _build_fake(gmsh, periodic_specs=[spec])

    assert captured["periodic_node_pairs"] == [
        {"pair_id": "box-x", "node_a": 0, "node_b": 1}
    ]
    assert captured["periodic_boundary_pairs"] == [
        {
            "pair_id": "box-x",
            "marker_a": 31,
            "marker_b": 32,
            "axis_hint": "x",
            "translation": [1.0, 0.0, 0.0],
            "tolerance_m": 0.01,
        }
    ]
    assert captured["periodic_patch_z_bounds"] == scopes


def test_periodic_pair_with_only_one_cap_endpoint_is_rejected(monkeypatch):
    _patch_shared_builders(monkeypatch, scopes={("box-x", 31, 32): (0.0, 2.0)})
    gmsh = _FakeGmsh(
        _cap_rows(),
        {
            201: (
                101,
                np.asarray([2, 900], dtype=np.uint64),
                np.asarray([1, 4], dtype=np.uint64),
                np.asarray([]),
            )
        },
    )

    with pytest.raises(ValueError, match="periodic.*pair.*retains only one endpoint"):
        _build_fake(gmsh, periodic_specs=[_periodic_spec()])


def test_periodic_surface_master_identity_is_preserved(monkeypatch):
    _patch_shared_builders(monkeypatch, scopes={("box-x", 31, 32): (0.0, 2.0)})
    gmsh = _FakeGmsh(
        _cap_rows(),
        {
            201: (
                999,
                np.asarray([2], dtype=np.uint64),
                np.asarray([1], dtype=np.uint64),
                np.asarray([]),
            )
        },
    )

    with pytest.raises(ValueError, match="mapped surface 201 to master 999, expected 101"):
        _build_fake(gmsh, periodic_specs=[_periodic_spec()])


@pytest.mark.parametrize("scale", [0.0, -1.0, float("inf"), True])
def test_invalid_gmsh_scale_is_rejected(monkeypatch, scale):
    _patch_shared_builders(monkeypatch)

    with pytest.raises((TypeError, ValueError), match="gmsh_units_per_m"):
        _build_fake(_FakeGmsh(_cap_rows()), gmsh_units_per_m=scale)


@pytest.mark.parametrize("indices", [(0, 0), (1, 0), (0, 2), (-1, 1)])
def test_invalid_magnetic_plane_indices_are_rejected(monkeypatch, indices):
    _patch_shared_builders(monkeypatch)

    with pytest.raises((TypeError, ValueError), match="magnetic_plane_indices"):
        _build_fake(_FakeGmsh(_cap_rows()), magnetic_plane_indices=indices)


def test_missing_cap_nodes_are_rejected(monkeypatch):
    _patch_shared_builders(monkeypatch)
    caps = _cap_rows()
    caps[12] = ([], [])

    with pytest.raises(ValueError, match="cap surface 12.*no mesh nodes"):
        _build_fake(_FakeGmsh(caps))


@pytest.fixture
def gmsh_session():
    gmsh = pytest.importorskip("gmsh")
    pytest.importorskip("scipy")
    started_here = not bool(gmsh.isInitialized())
    if started_here:
        gmsh.initialize()
    initial_models = set(gmsh.model.list())
    initial_current = gmsh.model.getCurrent()
    try:
        yield gmsh
    finally:
        for name in sorted(set(gmsh.model.list()) - initial_models, reverse=True):
            gmsh.model.setCurrent(name)
            gmsh.model.remove()
        if initial_current in gmsh.model.list():
            gmsh.model.setCurrent(initial_current)
        if started_here:
            gmsh.finalize()


def _add_rectangle_surface(gmsh, z):
    geometry = gmsh.model.geo
    points = [
        geometry.addPoint(x, y, z, 2.0)
        for x, y in ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
    ]
    curves = [
        geometry.addLine(points[index], points[(index + 1) % 4])
        for index in range(4)
    ]
    loop = geometry.addCurveLoop(curves)
    return geometry.addPlaneSurface([loop])


def test_real_generated_gmsh_caps_produce_tet4_mesh_and_quality(gmsh_session):
    gmsh = gmsh_session
    model_name = f"layered-box-caps-{uuid4().hex}"
    gmsh.model.add(model_name)
    lower = _add_rectangle_surface(gmsh, 0.0)
    material_lower = _add_rectangle_surface(gmsh, 1.0)
    upper = _add_rectangle_surface(gmsh, 2.0)
    gmsh.model.geo.synchronize()
    gmsh.model.mesh.generate(2)
    expected_by_tag = {}
    for surface_tag in (lower, material_lower, upper):
        tags, coordinates, _parametric = gmsh.model.mesh.getNodes(
            2,
            surface_tag,
            includeBoundary=True,
            returnParametricCoord=False,
        )
        for index, node_tag in enumerate(tags):
            point = tuple(float(value) for value in coordinates[3 * index : 3 * index + 3])
            previous = expected_by_tag.setdefault(int(node_tag), point)
            assert previous == point

    mesh = layered_box.build_layered_box_from_gmsh_caps(
        gmsh,
        cap_surface_tags=[lower, material_lower, upper],
        requested_layer_planes_si_m=[0.0, 1.0, 2.0],
        magnetic_plane_indices=(1, 2),
        bounds_xy_si_m=(0.0, 1.0, 0.0, 1.0),
        gmsh_units_per_m=1.0,
        options=MeshOptions(compute_quality=True),
        periodic_surface_specs=(),
        outer_boundary_marker=7,
    )

    expected_nodes = np.asarray(
        [expected_by_tag[tag] for tag in sorted(expected_by_tag)], dtype=np.float64
    )
    assert mesh.nodes.shape == expected_nodes.shape
    np.testing.assert_array_equal(mesh.nodes, expected_nodes)
    assert set(mesh.nodes[:, 2].tolist()) == {0.0, 1.0, 2.0}
    assert set(mesh.cell_types.tolist()) == {"tet4"}
    assert set(mesh.element_markers.tolist()) == {0, 1}
    assert mesh.quality is not None
    assert mesh.quality.n_elements == len(mesh.element_markers)
    assert mesh.per_domain_quality is not None
    assert set(mesh.per_domain_quality) == {0, 1}
