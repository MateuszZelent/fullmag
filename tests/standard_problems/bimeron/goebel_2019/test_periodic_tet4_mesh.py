from __future__ import annotations

import numpy as np

from fullmag.meshing._gmsh_extraction import certify_extracted_periodic_mesh
from tests.standard_problems.bimeron.goebel_2019.periodic_tet4_mesh import (
    AIRBOX_SIZE,
    build_mesh,
)


def _arrays(payload: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    nodes = np.asarray(payload["nodes"])
    cells = np.asarray(payload["cells"]["nodes"], dtype=np.int32).reshape(-1, 4)
    markers = np.asarray(payload["element_markers"], dtype=np.int32)
    return nodes, cells, markers


def _collar(
    nodes: np.ndarray, cells: np.ndarray, markers: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    collar_nodes = (np.abs(nodes[:, 1]) <= 27.0e-9 + 1e-21) & (
        np.abs(nodes[:, 2]) <= 7.25e-9 + 1e-21
    )
    collar_cells = np.all(collar_nodes[cells], axis=1)
    collar_ids = np.cumsum(collar_nodes) - 1
    return nodes[collar_nodes], collar_ids[cells[collar_cells]], markers[collar_cells]


def test_light_airbox_reduces_outer_cells_preserving_film_and_collar() -> None:
    reference = build_mesh()
    light = build_mesh(light_airbox=True)
    ref_nodes, ref_cells, ref_markers = _arrays(reference)
    nodes, cells, markers = _arrays(light)

    assert len(ref_cells) == 921_024
    assert len(cells) <= 0.84 * len(ref_cells)
    assert set(light["cells"]["types"]) == {"tet4"}
    np.testing.assert_allclose(nodes.min(axis=0), -np.asarray(AIRBOX_SIZE) / 2, atol=1e-21, rtol=0.0)
    np.testing.assert_allclose(nodes.max(axis=0), np.asarray(AIRBOX_SIZE) / 2, atol=1e-21, rtol=0.0)
    np.testing.assert_array_equal(ref_cells[ref_markers == 1], cells[markers == 1])
    for reference_part, light_part in zip(
        _collar(ref_nodes, ref_cells, ref_markers), _collar(nodes, cells, markers), strict=True
    ):
        np.testing.assert_array_equal(reference_part, light_part)

    for chunk in np.array_split(cells, 16):
        points = nodes[chunk]
        determinants = np.linalg.det(points[:, 1:] - points[:, :1])
        assert np.all(determinants > 1e-30)

    faces = np.asarray(light["facets"]["nodes"], dtype=np.int32).reshape(-1, 3)
    face_markers = np.asarray(light["boundary_markers"], dtype=np.int32)
    certificate = certify_extracted_periodic_mesh(
        nodes, faces, face_markers, light["periodic_boundary_pairs"], light["periodic_node_pairs"]
    )
    assert certificate["certificate_status"] == "accepted"
    assert certificate["axis_pair_count"] == 1
    assert certificate["node_pair_count"] == np.unique(faces[face_markers == 100]).size
