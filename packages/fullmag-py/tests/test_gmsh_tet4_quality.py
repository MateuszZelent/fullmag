from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

import numpy as np
import pytest

from fullmag.meshing import _gmsh_tet4_quality as quality_module
from fullmag.meshing._gmsh_extraction import GmshQualityExtractionError
from fullmag.meshing._gmsh_tet4_quality import quality_for_tet4_arrays
from fullmag.meshing._gmsh_types import MeshOptions


@pytest.fixture
def gmsh_session():
    gmsh = pytest.importorskip("gmsh")
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


def _tet4_arrays() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    nodes: list[list[float]] = []
    cells: list[list[int]] = []
    for edge, origin_x in ((1.0e-3, 0.0), (2.0e-3, 5.0e-3), (0.5e-3, 10.0e-3)):
        first = len(nodes)
        nodes.extend(
            [
                [origin_x, 0.0, 0.0],
                [origin_x + edge, 0.0, 0.0],
                [origin_x, edge, 0.0],
                [origin_x, 0.0, edge],
            ]
        )
        cells.append([first, first + 1, first + 2, first + 3])
    return (
        np.asarray(nodes, dtype=np.float64),
        np.asarray(cells, dtype=np.int64),
        np.asarray([0, 0, 7], dtype=np.int32),
    )


def _signed_volumes(nodes: np.ndarray, cells: np.ndarray) -> np.ndarray:
    points = nodes[cells]
    return np.einsum(
        "ij,ij->i",
        points[:, 1] - points[:, 0],
        np.cross(points[:, 2] - points[:, 0], points[:, 3] - points[:, 0]),
    ) / 6.0


def _mesh_snapshot(gmsh) -> tuple[object, ...]:
    node_tags, coordinates, _parametric = gmsh.model.mesh.getNodes()
    types, element_tag_blocks, connectivity_blocks = gmsh.model.mesh.getElements(dim=3)
    return (
        tuple(int(tag) for tag in node_tags),
        tuple(float(value) for value in coordinates),
        tuple(int(kind) for kind in types),
        tuple(tuple(int(tag) for tag in block) for block in element_tag_blocks),
        tuple(tuple(int(tag) for tag in block) for block in connectivity_blocks),
    )


def _add_caller_model(gmsh) -> tuple[str, tuple[object, ...]]:
    name = f"quality-caller-{uuid4().hex}"
    gmsh.model.add(name)
    entity = gmsh.model.addDiscreteEntity(3)
    node_tags = np.asarray([41, 42, 43, 44], dtype=np.uint64)
    coordinates = np.asarray(
        [
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            0.0, 1.0, 0.0,
            0.0, 0.0, 1.0,
        ],
        dtype=np.float64,
    )
    gmsh.model.mesh.addNodes(3, entity, node_tags, coordinates)
    gmsh.model.mesh.addElementsByType(
        entity,
        4,
        np.asarray([81], dtype=np.uint64),
        np.asarray([41, 42, 43, 44], dtype=np.uint64),
    )
    return name, _mesh_snapshot(gmsh)


def _assert_caller_model_unchanged(
    gmsh,
    *,
    caller_name: str,
    model_names_before: tuple[str, ...],
    mesh_before: tuple[object, ...],
) -> None:
    assert tuple(gmsh.model.list()) == model_names_before
    assert gmsh.model.getCurrent() == caller_name
    assert _mesh_snapshot(gmsh) == mesh_before


def test_actual_discrete_quality_uses_final_tet4_arrays_and_explicit_markers(
    gmsh_session,
    monkeypatch,
) -> None:
    gmsh = gmsh_session
    caller_name, caller_mesh_before = _add_caller_model(gmsh)
    model_names_before = tuple(gmsh.model.list())
    nodes, cells, markers = _tet4_arrays()
    expected_volumes = _signed_volumes(nodes, cells)
    assert np.all(expected_volumes > 0.0)

    previous_avg_quality = gmsh.option.getNumber("Mesh.AvgQuality")
    stale_avg_quality = 0.123456789
    original_extractor = quality_module._extract_quality_metrics

    def extractor_with_stale_average(*args, **kwargs):
        report, per_domain_report = original_extractor(*args, **kwargs)
        return replace(report, avg_quality=stale_avg_quality), per_domain_report

    monkeypatch.setattr(
        quality_module,
        "_extract_quality_metrics",
        extractor_with_stale_average,
    )
    quality, per_domain = quality_for_tet4_arrays(
        gmsh,
        nodes,
        cells,
        markers,
        MeshOptions(per_element_quality=True),
    )
    assert gmsh.option.getNumber("Mesh.AvgQuality") == previous_avg_quality

    assert quality.n_elements == len(cells)
    assert quality.element_tags == [1, 2, 3]
    assert quality.element_sicn is not None
    assert quality.element_gamma is not None
    assert quality.element_volume is not None
    assert len(quality.element_sicn) == len(cells)
    assert len(quality.element_gamma) == len(cells)
    assert len(quality.element_volume) == len(cells)
    np.testing.assert_allclose(quality.element_volume, expected_volumes, rtol=1.0e-12, atol=0.0)
    assert quality.avg_quality == pytest.approx(float(np.mean(quality.element_sicn)))
    assert quality.avg_quality != stale_avg_quality

    assert per_domain is not None
    assert set(per_domain) == {0, 7}
    assert per_domain[0].n_elements == 2
    assert per_domain[7].n_elements == 1
    assert per_domain[0].volume_mean == pytest.approx(float(np.mean(expected_volumes[:2])))
    assert per_domain[7].volume_mean == pytest.approx(float(expected_volumes[2]))
    _assert_caller_model_unchanged(
        gmsh,
        caller_name=caller_name,
        model_names_before=model_names_before,
        mesh_before=caller_mesh_before,
    )


def test_per_element_quality_policy_is_preserved(gmsh_session) -> None:
    gmsh = gmsh_session
    caller_name, caller_mesh_before = _add_caller_model(gmsh)
    model_names_before = tuple(gmsh.model.list())
    nodes, cells, markers = _tet4_arrays()

    quality, per_domain = quality_for_tet4_arrays(
        gmsh,
        nodes,
        cells,
        markers,
        MeshOptions(per_element_quality=False),
    )

    assert quality.n_elements == len(cells)
    assert quality.element_tags == [1, 2, 3]
    assert quality.element_sicn is None
    assert quality.element_gamma is None
    assert quality.element_volume is None
    assert per_domain is not None
    assert set(per_domain) == {0, 7}
    _assert_caller_model_unchanged(
        gmsh,
        caller_name=caller_name,
        model_names_before=model_names_before,
        mesh_before=caller_mesh_before,
    )


@pytest.mark.parametrize(
    ("field", "bad_value", "error", "message"),
    [
        ("nodes", np.zeros((4, 2), dtype=np.float64), ValueError, "nodes_si"),
        (
            "nodes",
            np.asarray(
                [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, np.nan]]
            ),
            ValueError,
            "finite",
        ),
        (
            "nodes",
            np.asarray(
                [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0j]]
            ),
            TypeError,
            "real",
        ),
        ("cells", np.asarray([[0.0, 1.0, 2.0, 3.0]]), TypeError, "integer"),
        ("cells", np.asarray([[0, 1, 2, 4]], dtype=np.int64), ValueError, "index"),
        ("cells", np.asarray([[0, 1, 2, 2]], dtype=np.int64), ValueError, "distinct"),
        ("markers", np.asarray([0.0]), TypeError, "integer"),
        ("markers", np.asarray([-1], dtype=np.int64), ValueError, "nonnegative"),
        ("markers", np.asarray([0, 7], dtype=np.int64), ValueError, "length"),
    ],
)
def test_array_validation_fails_before_gmsh_access(field, bad_value, error, message) -> None:
    nodes, cells, markers = _tet4_arrays()
    inputs = {"nodes": nodes[:4], "cells": cells[:1], "markers": markers[:1]}
    inputs[field] = bad_value

    with pytest.raises(error, match=message):
        quality_for_tet4_arrays(
            object(),
            inputs["nodes"],
            inputs["cells"],
            inputs["markers"],
            MeshOptions(),
        )


@pytest.mark.parametrize(
    "bad_cells",
    [np.asarray([[0, 2, 1, 3]], dtype=np.int64)],
)
def test_nonpositive_or_degenerate_tet_volume_is_rejected_before_gmsh(bad_cells) -> None:
    nodes = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    with pytest.raises(ValueError, match="strictly positive"):
        quality_for_tet4_arrays(
            object(),
            nodes,
            bad_cells,
            np.asarray([1], dtype=np.int32),
            MeshOptions(),
        )


def test_malformed_gmsh_channel_cleans_only_scratch_and_restores_caller(
    gmsh_session,
    monkeypatch,
) -> None:
    gmsh = gmsh_session
    caller_name, caller_mesh_before = _add_caller_model(gmsh)
    model_names_before = tuple(gmsh.model.list())
    nodes, cells, markers = _tet4_arrays()

    monkeypatch.setattr(gmsh.model.mesh, "getElementQualities", lambda _tags, _name: [])
    with pytest.raises(GmshQualityExtractionError, match="minSICN"):
        quality_for_tet4_arrays(gmsh, nodes, cells, markers, MeshOptions())

    _assert_caller_model_unchanged(
        gmsh,
        caller_name=caller_name,
        model_names_before=model_names_before,
        mesh_before=caller_mesh_before,
    )


@pytest.mark.parametrize("damage", ["count", "tag-order"])
def test_rejects_misaligned_extractor_result_and_restores_caller(
    gmsh_session,
    monkeypatch,
    damage: str,
) -> None:
    gmsh = gmsh_session
    caller_name, caller_mesh_before = _add_caller_model(gmsh)
    model_names_before = tuple(gmsh.model.list())
    nodes, cells, markers = _tet4_arrays()
    original = quality_module._extract_quality_metrics

    def damaged_extractor(*args, **kwargs):
        report, per_domain = original(*args, **kwargs)
        if damage == "count":
            report = replace(report, n_elements=report.n_elements - 1)
        else:
            assert report.element_tags is not None
            report = replace(report, element_tags=list(reversed(report.element_tags)))
        return report, per_domain

    monkeypatch.setattr(quality_module, "_extract_quality_metrics", damaged_extractor)
    with pytest.raises(GmshQualityExtractionError, match="element_tags"):
        quality_for_tet4_arrays(gmsh, nodes, cells, markers, MeshOptions())

    _assert_caller_model_unchanged(
        gmsh,
        caller_name=caller_name,
        model_names_before=model_names_before,
        mesh_before=caller_mesh_before,
    )
