"""Batched mixed-cell kernels must reproduce the scalar per-cell reference."""

from __future__ import annotations

import numpy as np
import pytest

import fullmag.meshing._gmsh_swept as gmsh_swept
import fullmag.meshing._gmsh_types as gmsh_types
from fullmag.meshing._gmsh_types import MeshData, _MIXED_CELL_LOCAL_FACETS
from fullmag.meshing._mixed_face_incidence import build_mixed_face_incidence


_REFERENCE_CELLS = {
    "tet4": np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
    "prism6": np.asarray(
        [
            [0.0, 0.0, -1.0],
            [1.0, 0.0, -1.0],
            [0.0, 1.0, -1.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
        ]
    ),
    "pyramid5": np.asarray(
        [[-1.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0], [-1.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    ),
    "hex8": np.asarray(
        [
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
            [-1.0, 1.0, 1.0],
        ]
    ),
}
_REVERSE = {
    "tet4": [0, 1, 3, 2],
    "prism6": [0, 2, 1, 3, 5, 4],
    "pyramid5": [0, 3, 2, 1, 4],
    "hex8": [1, 0, 3, 2, 5, 4, 7, 6],
}


def _bits(values: object) -> np.ndarray:
    return np.ascontiguousarray(np.asarray(values, dtype=np.float64)).view(np.uint64)


def _perturbed_cells(family: str, count: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = _REFERENCE_CELLS[family] * 1.0e-8
    cells = base + rng.normal(scale=0.2e-8, size=(count, *base.shape))
    cells[1] = cells[1][_REVERSE[family]]
    cells[2] = base[0]
    return cells


@pytest.mark.parametrize("family", ["tet4", "prism6", "pyramid5", "hex8"])
def test_batched_jacobian_determinants_match_scalar_bitwise(family: str) -> None:
    cells = _perturbed_cells(family, 129, seed=11)

    batch = gmsh_types._cell_jacobian_determinants_batch(family, cells)

    for row, cell in enumerate(cells):
        scalar = gmsh_types._cell_jacobian_determinants(family, cell)
        assert np.array_equal(_bits(batch[row]), _bits(scalar))


@pytest.mark.parametrize("family", ["tet4", "prism6", "pyramid5"])
def test_batched_scaled_jacobians_and_volumes_match_scalar_bitwise(family: str) -> None:
    cells = _perturbed_cells(family, 129, seed=17)

    determinants = gmsh_types._cell_jacobian_determinants_batch(family, cells)
    scaled = gmsh_types._mixed_cell_scaled_jacobians_batch(family, cells)
    volumes = gmsh_swept._mixed_v2_cell_volume_batch(family, cells, determinants)

    assert np.all(scaled[2] == 0.0)
    for row, cell in enumerate(cells):
        assert np.array_equal(
            _bits(scaled[row]), _bits(gmsh_types._mixed_cell_scaled_jacobians(family, cell))
        )
        assert _bits([volumes[row]])[0] == _bits([gmsh_swept._mixed_v2_cell_volume(family, cell)])[0]


def test_batched_volume_rejects_unsupported_family_like_scalar() -> None:
    cells = _perturbed_cells("hex8", 3, seed=5)
    determinants = gmsh_types._cell_jacobian_determinants_batch("hex8", cells)

    with pytest.raises(ValueError, match="mixed v2 volume does not support hex8"):
        gmsh_swept._mixed_v2_cell_volume_batch("hex8", cells, determinants)


def _disconnected_mesh(cells: list[tuple[str, np.ndarray]]) -> MeshData:
    nodes: list[np.ndarray] = []
    offsets = [0]
    for _family, coordinates in cells:
        nodes.append(coordinates)
        offsets.append(offsets[-1] + len(coordinates))
    return MeshData(
        nodes=np.concatenate(nodes),
        cell_types=[family for family, _coordinates in cells],
        cell_offsets=offsets,
        cell_nodes=list(range(offsets[-1])),
        cell_global_ordinals=list(range(100, 100 + len(cells))),
        element_markers=[1] * len(cells),
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )


def _inverted(family: str) -> np.ndarray:
    return _REFERENCE_CELLS[family][_REVERSE[family]]


def _degenerate(family: str) -> np.ndarray:
    nodes = np.array(_REFERENCE_CELLS[family], copy=True)
    nodes[:, 2] = 0.0
    return nodes


def test_oriented_copy_flips_exactly_the_fully_inverted_mixed_cells() -> None:
    cells = [
        ("tet4", _REFERENCE_CELLS["tet4"]),
        ("prism6", _inverted("prism6")),
        ("pyramid5", _REFERENCE_CELLS["pyramid5"]),
        ("tet4", _inverted("tet4")),
        ("hex8", _inverted("hex8")),
    ]
    mesh = _disconnected_mesh(cells)

    oriented = mesh.oriented_copy()

    expected = []
    for index, (family, _coordinates) in enumerate(cells):
        local = mesh.cell_node_ids(index)
        flipped = index in (1, 3, 4)
        expected.extend((local[_REVERSE[family]] if flipped else local).tolist())
    assert oriented.cell_nodes.tolist() == expected
    oriented.validate_strict()
    assert mesh.oriented_copy() is not mesh
    assert oriented.oriented_copy() is oriented


@pytest.mark.parametrize(
    ("cells", "message"),
    [
        (
            [
                ("prism6", _REFERENCE_CELLS["prism6"]),
                ("tet4", _REFERENCE_CELLS["tet4"]),
                ("pyramid5", _inverted("pyramid5")),
                ("tet4", _degenerate("tet4")),
                ("prism6", _degenerate("prism6")),
            ],
            r"cell 2 global ordinal 102 has negative pyramid5 Jacobian",
        ),
        (
            [
                ("prism6", _inverted("prism6")),
                ("tet4", _degenerate("tet4")),
            ],
            r"cell 0 global ordinal 100 has negative prism6 Jacobian",
        ),
        (
            [
                ("pyramid5", _REFERENCE_CELLS["pyramid5"]),
                ("prism6", _inverted("prism6")),
                ("tet4", _degenerate("tet4")),
            ],
            r"cell 1 global ordinal 101 has negative prism6 Jacobian",
        ),
        (
            [
                ("pyramid5", _REFERENCE_CELLS["pyramid5"]),
                ("tet4", _degenerate("tet4")),
                ("prism6", _inverted("prism6")),
            ],
            r"cell 1 global ordinal 101 has degenerate tet4 Jacobian \(degenerate tetra volume\)",
        ),
    ],
)
def test_strict_validation_reports_the_first_failing_cell_across_families(
    cells: list[tuple[str, np.ndarray]], message: str
) -> None:
    mesh = _disconnected_mesh(cells)

    with pytest.raises(ValueError, match=message):
        mesh.validate_strict()


def test_strict_validation_without_orientation_reports_only_degenerate_cells() -> None:
    mesh = _disconnected_mesh(
        [
            ("prism6", _inverted("prism6")),
            ("tet4", _REFERENCE_CELLS["tet4"]),
            ("pyramid5", _degenerate("pyramid5")),
        ]
    )

    with pytest.raises(ValueError, match=r"cell 2 global ordinal 102 has degenerate pyramid5 Jacobian"):
        mesh.validate_strict(require_positive_orientation=False)
    _disconnected_mesh([("prism6", _inverted("prism6"))]).validate_strict(
        require_positive_orientation=False
    )


def _reference_adjacency(mesh: MeshData) -> dict[tuple[int, ...], list[int]]:
    adjacency: dict[tuple[int, ...], list[int]] = {}
    for ordinal, family in enumerate(mesh.cell_types.tolist()):
        cell = mesh.cell_node_ids(ordinal)
        for local_face in _MIXED_CELL_LOCAL_FACETS[str(family)]:
            key = tuple(sorted(int(cell[index]) for index in local_face))
            adjacency.setdefault(key, []).append(ordinal)
    return adjacency


def _combinatorial_mesh(seed: int) -> MeshData:
    """Return a topology-only mesh whose small node pool forces shared faces."""
    rng = np.random.default_rng(seed)
    arities = {"tet4": 4, "prism6": 6, "pyramid5": 5}
    families = rng.choice(["tet4", "tet4", "tet4", "prism6", "pyramid5"], size=150).tolist()
    cell_nodes: list[int] = []
    offsets = [0]
    for family in families:
        cell_nodes.extend(rng.choice(14, size=arities[family], replace=False).tolist())
        offsets.append(len(cell_nodes))
    facet_nodes: list[int] = []
    facet_offsets = [0]
    facet_types: list[str] = []
    for arity in rng.choice([3, 4], size=60).tolist():
        facet_nodes.extend(rng.choice(14, size=arity, replace=False).tolist())
        facet_offsets.append(len(facet_nodes))
        facet_types.append("tri3" if arity == 3 else "quad4")
    return MeshData(
        nodes=rng.normal(size=(14, 3)),
        cell_types=families,
        cell_offsets=offsets,
        cell_nodes=cell_nodes,
        cell_global_ordinals=list(range(len(families))),
        element_markers=rng.choice([0, 1, 2], size=len(families)).tolist(),
        cell_mesh_parts=rng.choice(["magnetic", "transition_air", "far_air"], size=len(families)).tolist(),
        facet_types=facet_types,
        facet_roles=["exterior"] * len(facet_types),
        facet_offsets=facet_offsets,
        facet_nodes=facet_nodes,
        boundary_markers=[1] * len(facet_types),
        facet_global_ordinals=list(range(len(facet_types))),
    )


@pytest.mark.parametrize("seed", [3, 29])
@pytest.mark.parametrize("radix_nodes", [None, 1 << 21])
def test_face_incidence_matches_the_dictionary_reference(seed: int, radix_nodes: int | None) -> None:
    mesh = _combinatorial_mesh(seed)
    adjacency = _reference_adjacency(mesh)
    explicit = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        for ordinal in range(mesh.n_boundary_faces)
    }

    incidence = build_mixed_face_incidence(
        node_count=radix_nodes or mesh.n_nodes,
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        local_facets=_MIXED_CELL_LOCAL_FACETS,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
    )

    owned = incidence.cell_owner_counts > 0
    assert sorted(zip(incidence.cell_owner_counts[owned].tolist(), incidence.arity[owned].tolist())) == sorted(
        (len(owners), len(key)) for key, owners in adjacency.items()
    )
    assert int(np.count_nonzero(~owned)) == len(explicit - set(adjacency))
    for ordinal in range(mesh.n_boundary_faces):
        key = tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        owners = incidence.face_cell_owners(int(incidence.facet_face[ordinal]))
        assert sorted(owners.tolist()) == sorted(adjacency.get(key, []))

    nonmanifold = sum(1 for owners in adjacency.values() if len(owners) > 2)
    orphan = sum(1 for key, owners in adjacency.items() if len(owners) == 1 and key not in explicit)
    counts = gmsh_swept._mixed_v2_conformity_counts(mesh, incidence)
    assert counts["nonmanifold_face_count"] == nonmanifold > 0
    assert counts["orphan_face_count"] == orphan > 0
    assert gmsh_swept._mixed_v2_conformity_counts(mesh) == counts

    transition = sum(
        1
        for key, owners in adjacency.items()
        if len(owners) == 2
        and len(key) == 3
        and {str(mesh.cell_mesh_parts[index]) for index in owners} == {"transition_air", "far_air"}
    )
    assert gmsh_swept._mixed_v2_transition_interface_tri3_count(mesh, incidence) == transition > 0


def test_cell_nodes_where_matches_per_cell_concatenation() -> None:
    mesh = _combinatorial_mesh(7)
    mask = mesh.element_markers == 1

    expected = np.unique(np.concatenate([mesh.cell_node_ids(int(index)) for index in np.flatnonzero(mask)]))

    actual = gmsh_swept._mixed_v2_cell_nodes_where(mesh, mask)
    assert actual.dtype == expected.dtype
    assert np.array_equal(actual, expected)


def test_topology_fingerprint_fast_path_matches_per_item_encoding(monkeypatch: pytest.MonkeyPatch) -> None:
    mesh = _combinatorial_mesh(13)
    fast = mesh.topology_fingerprint_v3()

    monkeypatch.setattr(gmsh_types, "_fingerprint_f64x3_payload", lambda values: None)
    monkeypatch.setattr(gmsh_types, "_fingerprint_uint_payload", lambda values, bits: None)
    monkeypatch.setattr(gmsh_types, "_fingerprint_enum_payload", lambda values, mapping: None)

    assert mesh.topology_fingerprint_v3() == fast


@pytest.mark.parametrize(
    ("payload", "values"),
    [
        (lambda values: gmsh_types._fingerprint_f64x3_payload(values), np.asarray([[0.0, np.nan, 1.0]])),
        (lambda values: gmsh_types._fingerprint_uint_payload(values, 32), np.asarray([1, -1])),
        (lambda values: gmsh_types._fingerprint_uint_payload(values, 32), np.asarray([1 << 32])),
        (lambda values: gmsh_types._fingerprint_uint_payload(values, 32), np.asarray([True, False])),
        (lambda values: gmsh_types._fingerprint_enum_payload(values, {"tri3": 1}), np.asarray(["tri3", "hex"])),
    ],
)
def test_topology_fingerprint_fast_path_defers_invalid_values_to_the_item_writer(
    payload: object, values: np.ndarray
) -> None:
    assert payload(values) is None  # type: ignore[operator]


def _reference_faceted_magnetic_volume(mesh: MeshData) -> float:
    """The historical per-facet loop, kept as the bitwise reference."""
    face_owners: dict[tuple[int, ...], list[tuple[int, int]]] = {}
    for ordinal, family in enumerate(mesh.cell_types.tolist()):
        cell = mesh.cell_node_ids(ordinal)
        for local_face in _MIXED_CELL_LOCAL_FACETS[str(family)]:
            key = tuple(sorted(int(cell[index]) for index in local_face))
            face_owners.setdefault(key, []).append((ordinal, int(mesh.element_markers[ordinal])))
    volumes = {1: 0.0, 2: 0.0}
    for ordinal, (family, role, marker) in enumerate(
        zip(mesh.facet_types.tolist(), mesh.facet_roles.tolist(), mesh.boundary_markers.tolist())
    ):
        if role != "material_interface" or int(marker) != gmsh_swept.MIXED_INTERFACE_MARKER:
            continue
        nodes = tuple(int(node) for node in mesh.facet_node_ids(ordinal))
        owner, owner_marker = [
            item for item in face_owners.get(tuple(sorted(nodes)), []) if item[1] in volumes
        ][0]
        points = mesh.nodes[np.asarray(nodes, dtype=np.int64)]
        triangles = ((0, 1, 2),) if family == "tri3" else ((0, 1, 2), (0, 2, 3))
        owner_centroid = np.mean(mesh.nodes[mesh.cell_node_ids(owner)], axis=0)
        face_centroid = np.mean(points, axis=0)
        signed = 0.0
        for i, j, k in triangles:
            normal = np.cross(points[j] - points[i], points[k] - points[i])
            if float(np.dot(normal, face_centroid - owner_centroid)) < 0.0:
                j, k = k, j
            signed += float(np.linalg.det(np.stack((points[i], points[j], points[k]), axis=1)) / 6.0)
        volumes[owner_marker] += signed
    return float(sum(abs(value) for value in volumes.values()))


def _interface_mesh(seed: int, *, orphan_interface_facet: bool = False) -> MeshData:
    """A prism body, a tet body and an air tet that shares the prism base."""
    rng = np.random.default_rng(seed)
    prism = _REFERENCE_CELLS["prism6"] * 1.0e-8
    tet = _REFERENCE_CELLS["tet4"] * 1.0e-8 + np.asarray([5.0e-8, 0.0, 0.0])
    apex = np.asarray([[0.3e-8, 0.3e-8, -2.0e-8]])
    nodes = np.concatenate((prism, tet, apex)) + rng.normal(scale=0.05e-8, size=(11, 3))
    cells = [("prism6", [0, 1, 2, 3, 4, 5], 1), ("tet4", [6, 7, 8, 9], 2), ("tet4", [0, 2, 1, 10], 0)]
    facets: list[list[int]] = []
    for family, cell, marker in cells[:2]:
        facets.extend([cell[index] for index in face] for face in _MIXED_CELL_LOCAL_FACETS[family])
    if orphan_interface_facet:
        facets.append([3, 4, 10])
    return MeshData(
        nodes=nodes,
        cell_types=[family for family, _cell, _marker in cells],
        cell_offsets=np.cumsum([0] + [len(cell) for _family, cell, _marker in cells]).tolist(),
        cell_nodes=[node for _family, cell, _marker in cells for node in cell],
        cell_global_ordinals=list(range(len(cells))),
        element_markers=[marker for _family, _cell, marker in cells],
        facet_types=["tri3" if len(facet) == 3 else "quad4" for facet in facets],
        facet_roles=["material_interface"] * len(facets),
        facet_offsets=np.cumsum([0] + [len(facet) for facet in facets]).tolist(),
        facet_nodes=[node for facet in facets for node in facet],
        boundary_markers=[gmsh_swept.MIXED_INTERFACE_MARKER] * len(facets),
        facet_global_ordinals=list(range(len(facets))),
    )


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_faceted_magnetic_volume_matches_the_per_facet_reference_bitwise(seed: int) -> None:
    mesh = _interface_mesh(seed)

    actual = gmsh_swept._mixed_v2_closed_faceted_magnetic_volume(mesh)

    assert _bits([actual])[0] == _bits([_reference_faceted_magnetic_volume(mesh)])[0]
    assert actual > 0.0


def test_faceted_magnetic_volume_rejects_an_interface_facet_without_a_magnetic_owner() -> None:
    mesh = _interface_mesh(1, orphan_interface_facet=True)

    with pytest.raises(RuntimeError, match="does not have exactly one magnetic owner"):
        gmsh_swept._mixed_v2_closed_faceted_magnetic_volume(mesh)
