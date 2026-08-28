#!/usr/bin/env python3
"""Small real-Gmsh regression fixture for mixed tetrahedral repair.

The fixture is deliberately independent from the OCC/SP4 pipeline.  It uses one
discrete volume containing 25 disconnected six-node bipyramidal patches.  The
center patch has a manifold five-tetrahedral triangulation whose fifth tet is
coplanar; Gmsh's default tetrahedral optimizer removes that bridge by an edge
swap while preserving the cavity boundary.
"""

from __future__ import annotations

import argparse
from collections import Counter
import itertools
import json
from pathlib import Path
import sys
import time
from typing import Any

import numpy as np


_PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
)
if _PACKAGE_SOURCE.is_dir() and str(_PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_SOURCE))

import gmsh  # type: ignore[import-not-found]  # noqa: E402

from fullmag.meshing._gmsh_swept import _mixed_tet_degeneracy_report  # noqa: E402
from fullmag.meshing._gmsh_types import (  # noqa: E402
    FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS,
    _mixed_cell_scaled_jacobians,
)  # noqa: E402


SCHEMA = "fullmag.fem-mixed-tet-repair-microfixture.v1"
RUN_SCHEMA = "fullmag.fem-mixed-tet-repair-microfixture-run.v1"
GMSH_VOLUME_TAG = 1
GMSH_OPTIMIZE_THRESHOLD = 1.0e-6
PATCH_GRID_SIZE = 5
PATCH_COUNT = PATCH_GRID_SIZE * PATCH_GRID_SIZE
PATCH_NODE_COUNT = 6
CENTER_PATCH_INDEX = PATCH_COUNT // 2
CENTER_NODE_TAGS = tuple(
    range(
        CENTER_PATCH_INDEX * PATCH_NODE_COUNT + 1,
        (CENTER_PATCH_INDEX + 1) * PATCH_NODE_COUNT + 1,
    )
)
CENTER_TET_ELEMENT_TAGS = tuple(
    range(CENTER_PATCH_INDEX * 4 + 1, CENTER_PATCH_INDEX * 4 + 6)
)
CENTER_BRIDGE_ELEMENT_TAG = CENTER_TET_ELEMENT_TAGS[-1]
PRISM_NODE_TAGS = tuple(
    range(PATCH_COUNT * PATCH_NODE_COUNT + 1, PATCH_COUNT * PATCH_NODE_COUNT + 7)
)
PYRAMID_NODE_TAGS = tuple(range(PRISM_NODE_TAGS[-1] + 1, PRISM_NODE_TAGS[-1] + 6))
EXPECTED_NODE_COUNT = 161
EXPECTED_BEFORE_CELL_COUNTS = {"tet4": 101, "prism6": 1, "pyramid5": 1}
EXPECTED_AFTER_CELL_COUNTS = {"tet4": 100, "prism6": 1, "pyramid5": 1}


def _patch_coordinates(index: int) -> tuple[tuple[float, float, float], ...]:
    column = index % PATCH_GRID_SIZE
    row = index // PATCH_GRID_SIZE
    center_x = float((column - 2) * 4)
    center_y = float((row - 2) * 4)
    return (
        (center_x - 0.5, center_y - 0.5, 0.0),
        (center_x + 0.5, center_y - 0.5, 0.0),
        (center_x + 0.5, center_y + 0.5, 0.0),
        (center_x - 0.5, center_y + 0.5, 0.0),
        (center_x, center_y, 1.0),
        (center_x, center_y, -1.0),
    )


def _patch_cells(
    node_tags: tuple[int, ...], *, faulty: bool
) -> list[tuple[int, int, int, int]]:
    a, b, c, d, upper, lower = node_tags
    cells = [
        (a, b, c, upper),
        (a, b, c, lower),
        (a, d, upper, lower),
        (c, d, upper, lower),
    ]
    if faulty:
        # Opposite base diagonal (a,c) and opposite apex pair (upper,lower)
        # are coplanar in the symmetric bipyramid.
        cells.append((a, c, upper, lower))
    return cells


def _far_prism_and_pyramid_points() -> list[tuple[float, float, float]]:
    return [
        (100.0, 0.0, 0.0),
        (101.0, 0.0, 0.0),
        (100.0, 1.0, 0.0),
        (100.0, 0.0, 1.0),
        (101.0, 0.0, 1.0),
        (100.0, 1.0, 1.0),
        (110.0, 0.0, 0.0),
        (111.0, 0.0, 0.0),
        (111.0, 1.0, 0.0),
        (110.0, 1.0, 0.0),
        (110.5, 0.5, 1.0),
    ]


def _build_discrete_hybrid_mesh() -> None:
    gmsh.model.add("fem_mixed_tet_repair_microfixture")
    gmsh.model.addDiscreteEntity(3, GMSH_VOLUME_TAG)

    node_tags: list[int] = []
    coordinates: list[tuple[float, float, float]] = []
    tet_tags: list[int] = []
    tet_connectivity: list[int] = []
    next_element_tag = 1
    for patch_index in range(PATCH_COUNT):
        first_node_tag = patch_index * PATCH_NODE_COUNT + 1
        patch_node_tags = tuple(
            range(first_node_tag, first_node_tag + PATCH_NODE_COUNT)
        )
        node_tags.extend(patch_node_tags)
        coordinates.extend(_patch_coordinates(patch_index))
        for cell in _patch_cells(
            patch_node_tags, faulty=patch_index == CENTER_PATCH_INDEX
        ):
            tet_tags.append(next_element_tag)
            tet_connectivity.extend(cell)
            next_element_tag += 1

    far_points = _far_prism_and_pyramid_points()
    node_tags.extend(PRISM_NODE_TAGS)
    node_tags.extend(PYRAMID_NODE_TAGS)
    coordinates.extend(far_points)
    gmsh.model.mesh.addNodes(
        3,
        GMSH_VOLUME_TAG,
        node_tags,
        np.asarray(coordinates, dtype=np.float64).reshape(-1).tolist(),
    )
    gmsh.model.mesh.addElementsByType(
        GMSH_VOLUME_TAG,
        4,
        tet_tags,
        tet_connectivity,
    )
    gmsh.model.mesh.addElementsByType(
        GMSH_VOLUME_TAG,
        6,
        [next_element_tag],
        list(PRISM_NODE_TAGS),
    )
    gmsh.model.mesh.addElementsByType(
        GMSH_VOLUME_TAG,
        7,
        [next_element_tag + 1],
        list(PYRAMID_NODE_TAGS),
    )


def _coordinates_by_tag() -> dict[int, np.ndarray]:
    node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
    points = np.asarray(coordinates, dtype=np.float64).reshape((-1, 3))
    return {
        int(node_tag): point for node_tag, point in zip(node_tags, points, strict=True)
    }


def _elements(element_type: int, arity: int) -> np.ndarray:
    _, node_tags = gmsh.model.mesh.getElementsByType(element_type)
    return np.asarray(node_tags, dtype=np.int64).reshape((-1, arity))


def _cell_counts() -> dict[str, int]:
    return {
        "tet4": int(len(_elements(4, 4))),
        "prism6": int(len(_elements(6, 6))),
        "pyramid5": int(len(_elements(7, 5))),
    }


def _tet_quality_metrics(
    connectivity: np.ndarray,
    coordinates_by_tag: dict[int, np.ndarray],
) -> tuple[list[float], list[float]]:
    determinant_margins: list[float] = []
    scaled_jacobians: list[float] = []
    for cell in connectivity:
        points = np.asarray(
            [coordinates_by_tag[int(tag)] for tag in cell], dtype=np.float64
        )
        matrix = np.stack(
            (points[1] - points[0], points[2] - points[0], points[3] - points[0]),
            axis=1,
        )
        determinant = abs(float(np.linalg.det(matrix)))
        pairwise = points[:, np.newaxis, :] - points[np.newaxis, :, :]
        characteristic_length = float(np.max(np.linalg.norm(pairwise, axis=2)))
        threshold = max(
            np.finfo(np.float64).tiny,
            FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS * characteristic_length**3,
        )
        determinant_margins.append(determinant / threshold)
        scaled_jacobians.append(float(_mixed_cell_scaled_jacobians("tet4", points)[0]))
    return determinant_margins, scaled_jacobians


def _family_scaled_jacobians(
    coordinates_by_tag: dict[int, np.ndarray],
) -> dict[str, list[float]]:
    values: dict[str, list[float]] = {}
    for family, element_type, arity in (
        ("tet4", 4, 4),
        ("prism6", 6, 6),
        ("pyramid5", 7, 5),
    ):
        for cell in _elements(element_type, arity):
            points = np.asarray(
                [coordinates_by_tag[int(tag)] for tag in cell],
                dtype=np.float64,
            )
            values.setdefault(family, []).extend(
                float(value) for value in _mixed_cell_scaled_jacobians(family, points)
            )
    return values


def _cavity_face_counter(connectivity: np.ndarray) -> Counter[tuple[int, ...]]:
    cavity_nodes = set(CENTER_NODE_TAGS)
    cavity_cells = [
        tuple(int(tag) for tag in cell)
        for cell in connectivity
        if set(int(tag) for tag in cell).issubset(cavity_nodes)
    ]
    return Counter(
        tuple(sorted(face))
        for cell in cavity_cells
        for face in itertools.combinations(cell, 3)
    )


def _cavity_external_face_multiset(connectivity: np.ndarray) -> list[list[int]]:
    return [
        list(face)
        for face, count in sorted(_cavity_face_counter(connectivity).items())
        if count == 1
    ]


def _cavity_face_incidence(
    connectivity: np.ndarray,
) -> tuple[dict[str, int], int]:
    counts = _cavity_face_counter(connectivity)
    histogram = Counter(counts.values())
    return (
        {
            str(owner_count): int(face_count)
            for owner_count, face_count in sorted(histogram.items())
        },
        max(counts.values(), default=0),
    )


def _raw_connectivity() -> dict[str, list[list[int]]]:
    return {
        family: [
            [int(tag) for tag in cell]
            for cell in _elements(element_type, arity).tolist()
        ]
        for family, element_type, arity in (
            ("tet4", 4, 4),
            ("prism6", 6, 6),
            ("pyramid5", 7, 5),
        )
    }


def _topology_keys(connectivity: np.ndarray) -> list[list[int]]:
    return sorted(sorted(int(tag) for tag in cell) for cell in connectivity.tolist())


def _control_tet_topology_keys(connectivity: np.ndarray) -> list[list[int]]:
    center_nodes = set(CENTER_NODE_TAGS)
    return sorted(
        sorted(int(tag) for tag in cell)
        for cell in connectivity.tolist()
        if not center_nodes.intersection(int(tag) for tag in cell)
    )


def _topology_key_families() -> dict[str, list[list[int]]]:
    return {
        family: _topology_keys(_elements(element_type, arity))
        for family, element_type, arity in (
            ("tet4", 4, 4),
            ("prism6", 6, 6),
            ("pyramid5", 7, 5),
        )
    }


def _snapshot() -> dict[str, Any]:
    tet_connectivity = _elements(4, 4)
    coordinates_by_tag = _coordinates_by_tag()
    determinant_margins, scaled_jacobians = _tet_quality_metrics(
        tet_connectivity,
        coordinates_by_tag,
    )
    degeneracy = _mixed_tet_degeneracy_report(gmsh)
    cavity_faces = _cavity_external_face_multiset(tet_connectivity)
    cavity_face_incidence = _cavity_face_incidence(tet_connectivity)
    return {
        "cell_counts": _cell_counts(),
        "strict_degenerate_tet_count": len(degeneracy.element_tags),
        "strict_degenerate_tet_tags": sorted(degeneracy.element_tags),
        "cavity_external_face_multiset": cavity_faces,
        "cavity_face_incidence_histogram": cavity_face_incidence[0],
        "cavity_face_incidence_max": cavity_face_incidence[1],
        "control_tet_topology_keys": _control_tet_topology_keys(tet_connectivity),
        "topology_keys": _topology_key_families(),
        "raw_connectivity": _raw_connectivity(),
        "tet_determinant_margins": determinant_margins,
        "tet_scaled_jacobians": scaled_jacobians,
        "cell_scaled_jacobians": _family_scaled_jacobians(coordinates_by_tag),
    }


def _run_once_in_initialized_gmsh() -> dict[str, Any]:
    _build_discrete_hybrid_mesh()
    before = _snapshot()
    started = time.perf_counter_ns()
    gmsh.model.mesh.optimize(
        "",
        force=True,
        niter=1,
        dimTags=[(3, GMSH_VOLUME_TAG)],
    )
    repair_ns = time.perf_counter_ns() - started
    after = _snapshot()
    return {
        "schema": RUN_SCHEMA,
        "node_count": int(len(gmsh.model.mesh.getNodes()[0])),
        "before": before,
        "after": after,
        "repair_ns": int(repair_ns),
        "repair_ms": float(repair_ns) / 1_000_000.0,
    }


def run_once() -> dict[str, Any]:
    """Build, measure, and tear down one fresh real-Gmsh fixture."""
    if gmsh.isInitialized():
        raise RuntimeError("microfixture requires an uninitialized Gmsh session")
    gmsh.initialize([], False)
    previous_threshold = gmsh.option.getNumber("Mesh.OptimizeThreshold")
    previous_terminal = gmsh.option.getNumber("General.Terminal")
    gmsh.option.setNumber("Mesh.OptimizeThreshold", GMSH_OPTIMIZE_THRESHOLD)
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        result = _run_once_in_initialized_gmsh()
        if result["node_count"] != EXPECTED_NODE_COUNT:
            raise RuntimeError(f"unexpected node count: {result['node_count']}")
        if result["before"]["cell_counts"] != EXPECTED_BEFORE_CELL_COUNTS:
            raise RuntimeError(
                f"unexpected pre-repair counts: {result['before']['cell_counts']}"
            )
        if result["after"]["cell_counts"] != EXPECTED_AFTER_CELL_COUNTS:
            raise RuntimeError(
                f"unexpected post-repair counts: {result['after']['cell_counts']}"
            )
        return result
    finally:
        try:
            gmsh.clear()
        finally:
            try:
                gmsh.option.setNumber("Mesh.OptimizeThreshold", previous_threshold)
                gmsh.option.setNumber("General.Terminal", previous_terminal)
            finally:
                gmsh.finalize()


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("at least one run is required")
    if len(values) == 1:
        return float(values[0])
    position = (len(values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    weight = position - lower
    return float(values[lower] + (values[upper] - values[lower]) * weight)


def run_benchmark(*, runs: int = 10) -> dict[str, Any]:
    """Run fresh fixtures and return deterministic connectivity plus timing stats."""
    if isinstance(runs, bool) or not isinstance(runs, int) or runs < 1:
        raise ValueError("runs must be a positive integer")
    results = [run_once() for _ in range(runs)]
    first_topology_keys = results[0]["after"]["topology_keys"]
    first_raw_connectivity = results[0]["after"]["raw_connectivity"]
    first_counts = results[0]["after"]["cell_counts"]
    if any(
        result["after"]["topology_keys"] != first_topology_keys
        or result["after"]["raw_connectivity"] != first_raw_connectivity
        or result["after"]["cell_counts"] != first_counts
        for result in results[1:]
    ):
        raise RuntimeError(
            "fresh repair runs did not produce identical topology keys, "
            "ordered connectivity, or counts"
        )
    repair_ms = sorted(float(result["repair_ms"]) for result in results)
    summary = {
        "repair_ms": {
            "p50": _percentile(repair_ms, 0.50),
            "p95": _percentile(repair_ms, 0.95),
            "max": float(max(repair_ms)),
        },
        "repair_p95_gate": "pass" if _percentile(repair_ms, 0.95) < 50.0 else "blocked",
    }
    return {
        "schema": SCHEMA,
        "runs": results,
        "summary": summary,
    }


def _render_json(document: dict[str, Any]) -> str:
    return (
        json.dumps(
            document,
            sort_keys=True,
            ensure_ascii=False,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args(argv)
    report = run_benchmark(runs=arguments.runs)
    rendered = _render_json(report)
    if arguments.output is not None:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
