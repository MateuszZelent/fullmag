from __future__ import annotations

import math

import numpy as np
import pytest

from fullmag.meshing._gmsh_extraction import _semantic_marker_from_name
from fullmag.meshing import _layered_box_mesh_data as _layered_box_adapter
from fullmag.meshing._layered_box_mesh_data import build_layered_box_mesh_data


_SCALE = 2.0**-20
_PLANES = np.asarray(
    [-2.0 * _SCALE, -_SCALE, 0.0, _SCALE, 2.0 * _SCALE],
    dtype=np.float64,
)
_BOUNDS = (-2.0 * _SCALE, 2.0 * _SCALE, -2.0 * _SCALE, 2.0 * _SCALE)


def _layered_nodes(
    *,
    periodic_axis: int | tuple[int, ...] | None = None,
    middle_offsets: tuple[float, ...] = (-0.5 * _SCALE, 0.5 * _SCALE),
) -> np.ndarray:
    corners = (
        (_BOUNDS[0], _BOUNDS[2]),
        (_BOUNDS[1], _BOUNDS[2]),
        (_BOUNDS[1], _BOUNDS[3]),
        (_BOUNDS[0], _BOUNDS[3]),
    )
    offsets_by_plane = (
        (-0.75 * _SCALE,),
        (-0.5 * _SCALE, 0.5 * _SCALE),
        middle_offsets,
        (0.25 * _SCALE, 0.75 * _SCALE, 1.25 * _SCALE),
        (0.5 * _SCALE,),
    )
    nodes = [(x, y, float(z)) for z in _PLANES for x, y in corners]
    if periodic_axis is not None:
        axes = (periodic_axis,) if isinstance(periodic_axis, int) else periodic_axis
        for axis in axes:
            low, high = (_BOUNDS[0], _BOUNDS[1]) if axis == 0 else (_BOUNDS[2], _BOUNDS[3])
            other_axis = 1 - axis
            for z, offsets in zip(_PLANES, offsets_by_plane, strict=True):
                for side in (low, high):
                    for offset in offsets:
                        point = [0.0, 0.0, float(z)]
                        point[axis] = side
                        point[other_axis] = offset
                        nodes.append(tuple(point))
    return np.asarray(nodes, dtype=np.float64)


def _periodic_inputs(
    nodes: np.ndarray,
    axis: int,
    *,
    tolerance: float = 0.0,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    low, high = (_BOUNDS[0], _BOUNDS[1]) if axis == 0 else (_BOUNDS[2], _BOUNDS[3])
    width = high - low
    translation = [0.0, 0.0, 0.0]
    translation[axis] = width
    coordinate_to_index = {
        tuple(float(value) for value in point): index
        for index, point in enumerate(nodes)
    }
    node_pairs: list[dict[str, object]] = []
    for node_a, point in enumerate(nodes):
        if point[axis] != low:
            continue
        destination = point.copy()
        destination[axis] = high
        node_b = coordinate_to_index[tuple(float(value) for value in destination)]
        node_pairs.append({"pair_id": f"periodic-{axis}", "node_a": node_a, "node_b": node_b})
    boundary_pairs = [
        {
            "pair_id": f"periodic-{axis}",
            "marker_a": 31 + 2 * axis,
            "marker_b": 32 + 2 * axis,
            "axis_hint": "x" if axis == 0 else "y",
            "translation": translation,
            "tolerance_m": tolerance,
        }
    ]
    return boundary_pairs, node_pairs


def _scoped_periodic_inputs(
    nodes: np.ndarray,
    axis: int,
    *,
    marker_start: int,
    tolerance: float = 0.0,
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    dict[tuple[str, int, int], tuple[float, float]],
]:
    base_pairs, node_pairs = _periodic_inputs(nodes, axis, tolerance=tolerance)
    base = base_pairs[0]
    pair_id = str(base["pair_id"])
    boundary_pairs: list[dict[str, object]] = []
    patch_z_bounds: dict[tuple[str, int, int], tuple[float, float]] = {}
    for slab, (z_low, z_high) in enumerate(zip(_PLANES[:-1], _PLANES[1:], strict=True)):
        pair = dict(base)
        pair["marker_a"] = marker_start + 2 * slab
        pair["marker_b"] = marker_start + 2 * slab + 1
        boundary_pairs.append(pair)
        key = (pair_id, int(pair["marker_a"]), int(pair["marker_b"]))
        patch_z_bounds[key] = (float(z_low), float(z_high))
    return boundary_pairs, node_pairs, patch_z_bounds


def _triangle_areas_and_normals(mesh, face_ordinals: np.ndarray) -> tuple[float, list[np.ndarray]]:
    areas: list[float] = []
    normals: list[np.ndarray] = []
    for ordinal in face_ordinals:
        face = mesh.facet_node_ids(int(ordinal))
        points = mesh.nodes[face]
        normal = np.cross(points[1] - points[0], points[2] - points[0])
        areas.append(float(np.linalg.norm(normal)) / 2.0)
        normals.append(normal)
    return math.fsum(areas), normals


def test_builds_exact_region_and_interface_mesh_data() -> None:
    nodes = _layered_nodes()
    original = nodes.copy()
    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
    )
    repeated = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
    )

    np.testing.assert_array_equal(mesh.nodes, original)
    np.testing.assert_array_equal(mesh.cell_nodes, repeated.cell_nodes)
    np.testing.assert_array_equal(mesh.facet_nodes, repeated.facet_nodes)
    np.testing.assert_array_equal(mesh.facet_roles, repeated.facet_roles)
    np.testing.assert_array_equal(mesh.boundary_markers, repeated.boundary_markers)
    assert mesh.cell_types.tolist() == ["tet4"] * mesh.n_elements
    assert set(mesh.element_markers.tolist()) == {0, 1}
    assert mesh.cell_mesh_parts.shape == (0,)
    assert mesh.periodic_mesh_certificate is None
    assert mesh.quality is None
    assert mesh.per_domain_quality is None
    assert mesh.realization_report is None

    tet_points = mesh.nodes[mesh.elements]
    signed_six_volumes = np.einsum(
        "ij,ij->i",
        tet_points[:, 1] - tet_points[:, 0],
        np.cross(tet_points[:, 2] - tet_points[:, 0], tet_points[:, 3] - tet_points[:, 0]),
    )
    assert np.all(signed_six_volumes > 0.0)
    magnetic_volume = math.fsum(
        float(value) / 6.0
        for value, marker in zip(signed_six_volumes, mesh.element_markers, strict=True)
        if int(marker) == 1
    )
    air_volume = math.fsum(
        float(value) / 6.0
        for value, marker in zip(signed_six_volumes, mesh.element_markers, strict=True)
        if int(marker) == 0
    )
    cross_section = (_BOUNDS[1] - _BOUNDS[0]) * (_BOUNDS[3] - _BOUNDS[2])
    expected_magnetic_volume = cross_section * (2.0 * _SCALE)
    expected_total_volume = cross_section * (_PLANES[-1] - _PLANES[0])
    assert math.isclose(magnetic_volume, expected_magnetic_volume, rel_tol=1e-12)
    assert math.isclose(air_volume, expected_total_volume - expected_magnetic_volume, rel_tol=1e-12)

    interface_ordinals = np.flatnonzero(mesh.facet_roles == "material_interface")
    assert len(interface_ordinals) > 0
    assert np.all(mesh.boundary_markers[interface_ordinals] == 10)
    for z_value, expected_sign in ((-_SCALE, -1.0), (_SCALE, 1.0)):
        at_plane = [
            int(index)
            for index in interface_ordinals
            if np.all(mesh.nodes[mesh.facet_node_ids(int(index)), 2] == z_value)
        ]
        assert at_plane
        area, normals = _triangle_areas_and_normals(mesh, np.asarray(at_plane, dtype=np.int64))
        assert math.isclose(area, cross_section, rel_tol=1e-12)
        assert all(expected_sign * float(normal[2]) > 0.0 for normal in normals)

    exterior = mesh.facet_roles == "exterior"
    assert np.all(mesh.boundary_markers[exterior] == 90)
    assert np.all(mesh.facet_types == "tri3")
    assert np.array_equal(mesh.cell_global_ordinals, np.arange(mesh.n_elements))
    assert np.array_equal(mesh.facet_global_ordinals, np.arange(mesh.n_boundary_faces))


def test_air_marker_matches_canonical_gmsh_extraction_semantics() -> None:
    canonical_air_marker = _semantic_marker_from_name("air", 73)
    assert canonical_air_marker == 0

    mesh = build_layered_box_mesh_data(
        _layered_nodes(),
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
    )

    assert set(mesh.element_markers.tolist()) == {1, canonical_air_marker}
    air_cells = mesh.element_markers == canonical_air_marker
    magnetic_cells = mesh.element_markers == 1
    assert np.any(air_cells)
    assert np.any(magnetic_cells)
    interface = mesh.facet_roles == "material_interface"
    assert np.any(interface)
    np.testing.assert_array_equal(mesh.boundary_markers[interface], 10)


@pytest.mark.parametrize("axis", (0, 1), ids=("x", "y"))
def test_periodic_pair_covers_variable_side_nodes_and_complete_triangles(axis: int) -> None:
    nodes = _layered_nodes(periodic_axis=axis)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, axis)
    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
    )

    pair = boundary_pairs[0]
    seam = mesh.facet_roles == "periodic_seam"
    assert np.count_nonzero(seam) > 0
    assert set(mesh.boundary_markers[seam].tolist()) == {
        pair["marker_a"],
        pair["marker_b"],
    }
    assert len(mesh.periodic_node_pairs) == len(node_pairs)
    assert mesh.periodic_boundary_pairs == boundary_pairs
    assert mesh.periodic_mesh_certificate is None
    assert np.all(mesh.boundary_markers[mesh.facet_roles == "exterior"] == 90)


def test_simultaneous_x_y_periodic_pairs_close_at_shared_corners() -> None:
    nodes = _layered_nodes(periodic_axis=(0, 1))
    x_boundary, x_nodes = _periodic_inputs(nodes, 0)
    y_boundary, y_nodes = _periodic_inputs(nodes, 1)
    boundary_pairs = x_boundary + y_boundary
    node_pairs = x_nodes + y_nodes
    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
    )

    maps: dict[str, dict[int, int]] = {"periodic-0": {}, "periodic-1": {}}
    for pair in mesh.periodic_node_pairs:
        maps[str(pair["pair_id"])][int(pair["node_a"])] = int(pair["node_b"])
    shared_corner_sources = set(maps["periodic-0"]).intersection(maps["periodic-1"])
    assert shared_corner_sources
    for source in shared_corner_sources:
        x_then_y = maps["periodic-1"].get(maps["periodic-0"][source])
        y_then_x = maps["periodic-0"].get(maps["periodic-1"][source])
        assert x_then_y is not None
        assert x_then_y == y_then_x
    assert set(mesh.boundary_markers[mesh.facet_roles == "periodic_seam"].tolist()) == {
        31,
        32,
        33,
        34,
    }
    assert mesh.periodic_boundary_pairs == boundary_pairs
    assert mesh.periodic_mesh_certificate is None


def test_periodic_pair_rejects_partial_node_map() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    with pytest.raises(ValueError, match="bijectively cover every node"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs[:-1],
        )


def test_periodic_pair_rejects_nonbijective_node_map() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    node_pairs[1]["node_b"] = node_pairs[0]["node_b"]
    with pytest.raises(ValueError, match="not bijective"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
        )


def test_periodic_pair_rejects_duplicate_pair_ids() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    boundary_pairs.append(dict(boundary_pairs[0]))
    with pytest.raises(ValueError, match="duplicate periodic pair_id"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
        )


def test_periodic_pair_rejects_translation_that_is_not_exact_box_width() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    boundary_pairs[0]["translation"] = [4.0 * _SCALE + _SCALE / 8.0, 0.0, 0.0]
    with pytest.raises(ValueError, match="exact x-box width"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
        )


def test_periodic_pair_rejects_marker_collision() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    boundary_pairs[0]["marker_a"] = 90
    with pytest.raises(ValueError, match="distinct from interface marker 10"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
        )


def test_periodic_pair_rejects_mismatched_complete_triangle_sets() -> None:
    delta = _SCALE / 1024.0
    nodes = _layered_nodes(periodic_axis=0, middle_offsets=(0.0, delta))
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0, tolerance=delta)
    source_by_y = {
        float(nodes[int(pair["node_a"]), 1]): index
        for index, pair in enumerate(node_pairs)
        if nodes[int(pair["node_a"]), 2] == 0.0
    }
    assert 0.0 in source_by_y and delta in source_by_y
    first = source_by_y[0.0]
    second = source_by_y[delta]
    node_pairs[first]["node_b"], node_pairs[second]["node_b"] = (
        node_pairs[second]["node_b"],
        node_pairs[first]["node_b"],
    )

    with pytest.raises(ValueError, match="mismatched complete triangle sets"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
        )


def test_adapter_rejects_unknown_periodic_schema_fields() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    boundary_pairs[0]["unsupported"] = "not part of the periodic pair schema"
    with pytest.raises(ValueError, match="unknown fields"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
        )


def test_adapter_rejects_non_plane_magnetic_bounds() -> None:
    nodes = _layered_nodes()
    with pytest.raises(ValueError, match="existing layer planes"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-0.5 * _SCALE, _SCALE),
            outer_boundary_marker=90,
        )


def test_adapter_rejects_magnetic_bounds_without_air_region() -> None:
    nodes = _layered_nodes()
    with pytest.raises(ValueError, match="no air tetrahedra"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(_PLANES[0], _PLANES[-1]),
            outer_boundary_marker=90,
        )


def test_adapter_rejects_boolean_magnetic_bound() -> None:
    nodes = _layered_nodes()
    with pytest.raises(TypeError, match="real number"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(False, _SCALE),
            outer_boundary_marker=90,
        )


def test_periodic_patch_scopes_preserve_four_marker_pairs_per_axis() -> None:
    nodes = _layered_nodes(periodic_axis=(0, 1))
    x_pairs, x_nodes, x_scopes = _scoped_periodic_inputs(nodes, 0, marker_start=101)
    y_pairs, y_nodes, y_scopes = _scoped_periodic_inputs(nodes, 1, marker_start=201)
    boundary_pairs = x_pairs + y_pairs
    node_pairs = x_nodes + y_nodes
    patch_z_bounds = {**x_scopes, **y_scopes}

    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
        periodic_patch_z_bounds=patch_z_bounds,
    )

    assert mesh.periodic_boundary_pairs == boundary_pairs
    assert len(mesh.periodic_boundary_pairs) == 8
    assert len(mesh.periodic_node_pairs) == len(node_pairs)
    assert len(
        {
            (str(pair["pair_id"]), int(pair["node_a"]), int(pair["node_b"]))
            for pair in mesh.periodic_node_pairs
        }
    ) == len(mesh.periodic_node_pairs)
    assert set(mesh.boundary_markers[mesh.facet_roles == "periodic_seam"].tolist()) == {
        marker
        for pair in boundary_pairs
        for marker in (int(pair["marker_a"]), int(pair["marker_b"]))
    }
    assert np.all(mesh.boundary_markers[mesh.facet_roles == "exterior"] == 90)
    assert np.all(mesh.boundary_markers[mesh.facet_roles == "material_interface"] == 10)

    for rows, scopes in ((x_pairs, x_scopes), (y_pairs, y_scopes)):
        pair_id = str(rows[0]["pair_id"])
        mapping = {
            int(pair["node_a"]): int(pair["node_b"])
            for pair in mesh.periodic_node_pairs
            if pair["pair_id"] == pair_id
        }
        for pair in rows:
            key = (pair_id, int(pair["marker_a"]), int(pair["marker_b"]))
            z_low, z_high = scopes[key]
            source_faces = [
                mesh.facet_node_ids(index)
                for index in range(mesh.n_boundary_faces)
                if mesh.facet_roles[index] == "periodic_seam"
                and mesh.boundary_markers[index] == pair["marker_a"]
            ]
            destination_faces = [
                mesh.facet_node_ids(index)
                for index in range(mesh.n_boundary_faces)
                if mesh.facet_roles[index] == "periodic_seam"
                and mesh.boundary_markers[index] == pair["marker_b"]
            ]
            assert source_faces and destination_faces
            for face in (*source_faces, *destination_faces):
                face_z = mesh.nodes[np.asarray(face, dtype=np.int64), 2]
                assert float(face_z.min()) == z_low
                assert float(face_z.max()) == z_high
            mapped = {
                tuple(sorted(mapping[int(node)] for node in face))
                for face in source_faces
            }
            destination = {
                tuple(sorted(int(node) for node in face))
                for face in destination_faces
            }
            assert mapped == destination


@pytest.mark.parametrize("missing_or_extra", ("missing", "extra", "ambiguous"))
def test_periodic_patch_scopes_reject_missing_or_extra_keys(missing_or_extra: str) -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101
    )
    if missing_or_extra == "missing":
        patch_z_bounds.pop(next(iter(patch_z_bounds)))
        expected = "missing z scope"
    elif missing_or_extra == "extra":
        patch_z_bounds[("periodic-0", 901, 902)] = (float(_PLANES[0]), float(_PLANES[1]))
        expected = "unexpected periodic patch z scope"
    else:
        key = next(iter(patch_z_bounds))
        patch_z_bounds[(f" {key[0]} ", key[1], key[2])] = patch_z_bounds[key]
        expected = "ambiguous periodic patch z scope key"

    with pytest.raises(ValueError, match=expected):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds=patch_z_bounds,
        )


@pytest.mark.parametrize(
    ("invalid_scope", "message"),
    (
        ((float(_PLANES[0]), float(_PLANES[1]) + _SCALE / 1024.0), "exact layer plane"),
        ((float(_PLANES[1]), float(_PLANES[0])), "increasing"),
        ((float(_PLANES[0]), float(_PLANES[0])), "increasing"),
        ((float("nan"), float(_PLANES[1])), "finite"),
        ((float(_PLANES[0]), float("inf")), "finite"),
        ((False, float(_PLANES[1])), "real number"),
        ((float(_PLANES[0]), float(_PLANES[1]), float(_PLANES[2])), "two finite real z bounds"),
    ),
)
def test_periodic_patch_scopes_reject_invalid_bounds(
    invalid_scope: object,
    message: str,
) -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101
    )
    patch_z_bounds[next(iter(patch_z_bounds))] = invalid_scope  # type: ignore[assignment]

    error_type = TypeError if message == "real number" else ValueError
    with pytest.raises(error_type, match=message):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds=patch_z_bounds,
        )


@pytest.mark.parametrize("partition_error", ("gap", "overlap"))
def test_periodic_patch_scopes_must_partition_the_exact_z_domain(partition_error: str) -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101
    )
    if partition_error == "gap":
        boundary_pairs = [boundary_pairs[index] for index in (0, 2, 3)]
        patch_z_bounds = {
            key: value
            for key, value in patch_z_bounds.items()
            if key != ("periodic-0", 103, 104)
        }
        expected = "gap"
    else:
        patch_z_bounds[("periodic-0", 101, 102)] = (
            float(_PLANES[0]),
            float(_PLANES[2]),
        )
        patch_z_bounds[("periodic-0", 103, 104)] = (
            float(_PLANES[1]),
            float(_PLANES[2]),
        )
        expected = "overlap"

    with pytest.raises(ValueError, match=expected):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds=patch_z_bounds,
        )


@pytest.mark.parametrize("inconsistency", ("translation", "tolerance"))
def test_periodic_patch_rows_require_one_logical_translation_and_tolerance(
    inconsistency: str,
) -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101
    )
    if inconsistency == "translation":
        boundary_pairs[1]["translation"] = [-4.0 * _SCALE, 0.0, 0.0]
    else:
        boundary_pairs[1]["tolerance_m"] = 1.0e-15

    with pytest.raises(ValueError, match="inconsistent.*translation|direction|tolerance"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds=patch_z_bounds,
        )


def test_periodic_patch_rows_reject_a_second_pair_id_for_the_same_axis() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    second = dict(boundary_pairs[0])
    second["pair_id"] = "another-x-pair"
    second["marker_a"] = 41
    second["marker_b"] = 42

    with pytest.raises(ValueError, match="only one periodic pair per axis"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs + [second],
            periodic_node_pairs=node_pairs,
        )


def test_periodic_patch_triangle_bijection_is_checked_per_scope() -> None:
    delta = _SCALE / 1024.0
    nodes = _layered_nodes(periodic_axis=0, middle_offsets=(0.0, delta))
    boundary_pairs, node_pairs, patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101, tolerance=delta
    )
    source_by_y = {
        float(nodes[int(pair["node_a"]), 1]): index
        for index, pair in enumerate(node_pairs)
        if nodes[int(pair["node_a"]), 2] == 0.0
    }
    assert 0.0 in source_by_y and delta in source_by_y
    first = source_by_y[0.0]
    second = source_by_y[delta]
    node_pairs[first]["node_b"], node_pairs[second]["node_b"] = (
        node_pairs[second]["node_b"],
        node_pairs[first]["node_b"],
    )

    with pytest.raises(ValueError, match="mismatched complete triangle sets"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds=patch_z_bounds,
        )


def test_single_periodic_patch_accepts_explicit_full_domain_scope() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    pair = boundary_pairs[0]
    key = (str(pair["pair_id"]), int(pair["marker_a"]), int(pair["marker_b"]))

    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
        periodic_patch_z_bounds={key: (float(_PLANES[0]), float(_PLANES[-1]))},
    )

    assert mesh.periodic_boundary_pairs == boundary_pairs
    assert set(mesh.boundary_markers[mesh.facet_roles == "periodic_seam"].tolist()) == {
        int(pair["marker_a"]),
        int(pair["marker_b"]),
    }


def test_single_periodic_patch_rejects_explicit_partial_scope() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs = _periodic_inputs(nodes, 0)
    pair = boundary_pairs[0]
    key = (str(pair["pair_id"]), int(pair["marker_a"]), int(pair["marker_b"]))

    with pytest.raises(ValueError, match="full exact z domain"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds={key: (float(_PLANES[0]), float(_PLANES[1]))},
        )


def test_mixed_split_and_single_periodic_pair_scopes() -> None:
    nodes = _layered_nodes(periodic_axis=(0, 1))
    x_pairs, x_nodes, x_scopes = _scoped_periodic_inputs(nodes, 0, marker_start=101)
    y_pairs, y_nodes = _periodic_inputs(nodes, 1)
    y_pair = y_pairs[0]
    y_key = (str(y_pair["pair_id"]), int(y_pair["marker_a"]), int(y_pair["marker_b"]))
    scopes = {
        **x_scopes,
        y_key: (float(_PLANES[0]), float(_PLANES[-1])),
    }

    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
        periodic_boundary_pairs=x_pairs + y_pairs,
        periodic_node_pairs=x_nodes + y_nodes,
        periodic_patch_z_bounds=scopes,
    )

    assert len(mesh.periodic_boundary_pairs) == 5
    assert set(mesh.boundary_markers[mesh.facet_roles == "periodic_seam"].tolist()) == {
        marker
        for pair in x_pairs + y_pairs
        for marker in (int(pair["marker_a"]), int(pair["marker_b"]))
    }


def test_periodic_patch_validator_rejects_unmarked_side_facets() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101
    )
    mesh = build_layered_box_mesh_data(
        nodes,
        _PLANES,
        _BOUNDS,
        magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
        periodic_patch_z_bounds=patch_z_bounds,
    )
    normalized_pairs, pair_by_id = _layered_box_adapter._normalize_boundary_pairs(
        boundary_pairs,
        bounds_xy=_BOUNDS,
        planes=_PLANES,
        outer_boundary_marker=90,
        periodic_patch_z_bounds=patch_z_bounds,
    )
    normalized_nodes, node_maps = _layered_box_adapter._normalize_node_pairs(
        node_pairs,
        pair_by_id=pair_by_id,
        node_count=len(nodes),
    )
    facets = [
        (
            tuple(int(node) for node in mesh.facet_node_ids(index)),
            str(mesh.facet_roles[index]),
            int(mesh.boundary_markers[index]),
        )
        for index in range(mesh.n_boundary_faces)
    ]

    pair = normalized_pairs[0]
    marker_a = int(pair["marker_a"])
    marker_b = int(pair["marker_b"])
    mapping = node_maps[str(pair["pair_id"])]
    source_faces = [
        face
        for face, role, marker in facets
        if role == "periodic_seam" and marker == marker_a
    ]
    destination_keys = {
        tuple(sorted(face))
        for face, role, marker in facets
        if role == "periodic_seam" and marker == marker_b
    }
    source_use_count: dict[int, int] = {}
    for face in source_faces:
        for node in face:
            source_use_count[node] = source_use_count.get(node, 0) + 1
    source_face = next(
        face
        for face in source_faces
        if all(source_use_count[node] > 1 for node in face)
        and tuple(sorted(mapping[node] for node in face)) in destination_keys
    )
    destination_key = tuple(sorted(mapping[node] for node in source_face))
    assert destination_key in destination_keys

    mutated_facets: list[tuple[tuple[int, int, int], str, int]] = []
    for face, role, marker in facets:
        if (
            role == "periodic_seam"
            and (
                (marker == marker_a and tuple(sorted(face)) == tuple(sorted(source_face)))
                or (marker == marker_b and tuple(sorted(face)) == destination_key)
            )
        ):
            mutated_facets.append((face, "exterior", 90))
        else:
            mutated_facets.append((face, role, marker))

    with pytest.raises(ValueError, match="complete side unions"):
        _layered_box_adapter._validate_periodic_topology(
            nodes=mesh.nodes,
            facets=mutated_facets,
            bounds_xy=_BOUNDS,
            boundary_pairs=normalized_pairs,
            node_maps=node_maps,
            node_pairs=normalized_nodes,
        )


def test_periodic_patch_scope_mapping_must_be_a_mapping() -> None:
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, _patch_z_bounds = _scoped_periodic_inputs(
        nodes, 0, marker_start=101
    )
    with pytest.raises(TypeError, match="mapping"):
        build_layered_box_mesh_data(
            nodes,
            _PLANES,
            _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE),
            outer_boundary_marker=90,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=node_pairs,
            periodic_patch_z_bounds=[],
        )


@pytest.mark.parametrize("method", ["auto", "unknown", "", None, True, []])
def test_unknown_tetrahedralization_method_fails_before_running_kernel(monkeypatch, method) -> None:
    def forbidden(*args, **kwargs):
        raise AssertionError("invalid method invoked a topology kernel")
    monkeypatch.setattr(_layered_box_adapter, "tetrahedralize_layered_box", forbidden)
    with pytest.raises(ValueError, match="tetrahedralization_method"):
        build_layered_box_mesh_data(
            _layered_nodes(), _PLANES, _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE), outer_boundary_marker=90,
            tetrahedralization_method=method,
        )


def test_delaunay_dispatch_preserves_authored_periodic_inputs(monkeypatch) -> None:
    import sys
    from types import ModuleType
    nodes = _layered_nodes(periodic_axis=0)
    boundary_pairs, node_pairs, scopes = _scoped_periodic_inputs(nodes, 0, marker_start=101)
    cells = _layered_box_adapter.tetrahedralize_layered_box(nodes, _PLANES, _BOUNDS)
    module = ModuleType("fullmag.meshing._layered_box_delaunay")
    calls = []
    def selected(actual_nodes, actual_planes, actual_bounds, **kwargs):
        assert actual_nodes is nodes and actual_planes is _PLANES and actual_bounds is _BOUNDS
        assert kwargs["periodic_boundary_pairs"] is boundary_pairs
        assert kwargs["periodic_node_pairs"] is node_pairs
        assert kwargs["periodic_patch_z_bounds"] is scopes
        calls.append(True)
        return cells
    module.tetrahedralize_layered_box_delaunay = selected
    monkeypatch.setitem(sys.modules, module.__name__, module)
    def forbidden(*args, **kwargs):
        raise AssertionError("selected Delaunay reran the Freudenthal kernel")
    monkeypatch.setattr(_layered_box_adapter, "tetrahedralize_layered_box", forbidden)
    mesh = build_layered_box_mesh_data(
        nodes, _PLANES, _BOUNDS, magnetic_z_bounds=(-_SCALE, _SCALE),
        outer_boundary_marker=90, periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs, periodic_patch_z_bounds=scopes,
        tetrahedralization_method="delaunay",
    )
    assert calls == [True]
    assert mesh.periodic_boundary_pairs == boundary_pairs
    assert mesh.periodic_node_pairs == node_pairs
    np.testing.assert_array_equal(mesh.cell_nodes.reshape((-1,4)), cells)
    assert set(mesh.element_markers.tolist()) == {0, 1}


def test_delaunay_failure_is_not_replaced_by_freudenthal(monkeypatch) -> None:
    import sys
    from types import ModuleType
    module = ModuleType("fullmag.meshing._layered_box_delaunay")
    def selected(*args, **kwargs):
        raise ValueError("selected topology has unresolved periodic triangles")
    module.tetrahedralize_layered_box_delaunay = selected
    monkeypatch.setitem(sys.modules, module.__name__, module)
    def forbidden(*args, **kwargs):
        raise AssertionError("failed selected method silently fell back")
    monkeypatch.setattr(_layered_box_adapter, "tetrahedralize_layered_box", forbidden)
    with pytest.raises(ValueError, match="unresolved periodic triangles"):
        build_layered_box_mesh_data(
            _layered_nodes(), _PLANES, _BOUNDS,
            magnetic_z_bounds=(-_SCALE, _SCALE), outer_boundary_marker=90,
            tetrahedralization_method="delaunay",
        )
