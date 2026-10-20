"""Regression tests for the producer-side FEM volume node compaction."""

from __future__ import annotations

import numpy as np
import pytest

from fullmag.meshing._gmsh_extraction import _compact_volume_node_space


def test_compacts_orphans_and_remaps_connectivity_identity_and_periodicity() -> None:
    nodes = np.arange(18, dtype=np.float64).reshape(6, 3)
    cells = np.asarray([0, 2, 5, 3], dtype=np.int32)
    facets = np.asarray([0, 5, 3], dtype=np.int32)
    identity = {
        "schema_version": "mesh_vertex_identity.v1",
        "issuer": "fixture.v1",
        "vertex_ids": [100, 110, 120, 130, 140, 150],
        "source": "synthetic-orphan-fixture",
    }
    periodic = [
        {
            "pair_id": "x-periodic",
            "node_a": 0,
            "node_b": 5,
            "translation": [1.0, 0.0, 0.0],
        }
    ]

    compacted = _compact_volume_node_space(
        nodes,
        cells,
        facets,
        vertex_identity=identity,
        periodic_node_pairs=periodic,
    )

    compact_nodes, compact_cells, compact_facets, compact_identity, compact_periodic = compacted
    np.testing.assert_array_equal(compact_nodes, nodes[[0, 2, 3, 5]])
    np.testing.assert_array_equal(compact_cells, [0, 1, 3, 2])
    np.testing.assert_array_equal(compact_facets, [0, 3, 2])
    assert compact_identity == {
        "schema_version": "mesh_vertex_identity.v1",
        "issuer": "fixture.v1",
        "vertex_ids": [100, 120, 130, 150],
        "source": "synthetic-orphan-fixture",
    }
    assert compact_periodic == [
        {
            "pair_id": "x-periodic",
            "node_a": 0,
            "node_b": 3,
            "translation": [1.0, 0.0, 0.0],
        }
    ]
    assert identity["vertex_ids"] == [100, 110, 120, 130, 140, 150]
    assert periodic[0]["node_a"] == 0
    assert periodic[0]["node_b"] == 5


def test_valid_mixed_topology_keeps_air_and_interface_nodes_and_metadata() -> None:
    # The prism and pyramid stand for air/interface cells. Compaction is
    # support based and must retain every node used by any volume family.
    nodes = np.arange(45, dtype=np.float64).reshape(15, 3)
    cells = np.concatenate(
        [
            np.asarray([0, 1, 2, 3], dtype=np.int32),       # magnetic tet4
            np.asarray([4, 5, 6, 7, 8, 9], dtype=np.int32),  # interface prism6
            np.asarray([10, 11, 12, 13, 14], dtype=np.int32),  # air pyramid5
        ]
    )
    facets = np.asarray([0, 4, 9, 10, 11, 14], dtype=np.int32)
    identity = {
        "schema_version": "mesh_vertex_identity.v1",
        "issuer": "fixture.v1",
        "vertex_ids": list(range(500, 515)),
        "material_labels": ["magnetic", "interface", "air"],
    }
    periodic = [{"pair_id": "z", "node_a": 3, "node_b": 14, "ordinal": 7}]

    compact_nodes, compact_cells, compact_facets, compact_identity, compact_periodic = (
        _compact_volume_node_space(
            nodes,
            cells,
            facets,
            vertex_identity=identity,
            periodic_node_pairs=periodic,
        )
    )

    np.testing.assert_array_equal(compact_nodes, nodes)
    np.testing.assert_array_equal(compact_cells, cells)
    np.testing.assert_array_equal(compact_facets, facets)
    assert compact_identity == identity
    assert compact_periodic == periodic


def test_facet_reference_to_pruned_node_fails_closed() -> None:
    nodes = np.zeros((5, 3), dtype=np.float64)

    with pytest.raises(ValueError, match="facet-referenced orphan node 4"):
        _compact_volume_node_space(
            nodes,
            np.asarray([0, 1, 2, 3], dtype=np.int32),
            np.asarray([0, 1, 4], dtype=np.int32),
        )


def test_periodic_reference_to_pruned_node_fails_closed() -> None:
    nodes = np.zeros((5, 3), dtype=np.float64)

    with pytest.raises(ValueError, match="periodic_node_pairs orphan node 4"):
        _compact_volume_node_space(
            nodes,
            np.asarray([0, 1, 2, 3], dtype=np.int32),
            np.zeros(0, dtype=np.int32),
            periodic_node_pairs=[{"pair_id": "p", "node_a": 0, "node_b": 4}],
        )


def test_empty_volume_connectivity_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one volume node"):
        _compact_volume_node_space(
            np.zeros((2, 3), dtype=np.float64),
            np.zeros(0, dtype=np.int32),
            np.zeros(0, dtype=np.int32),
        )
