from __future__ import annotations

import numpy as np


def tetra_edge_lengths(nodes: np.ndarray, elements: np.ndarray) -> np.ndarray:
    verts = nodes[elements]
    pairs = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
    return np.stack(
        [np.linalg.norm(verts[:, a] - verts[:, b], axis=1) for a, b in pairs],
        axis=1,
    )


def characteristic_tet_size(nodes: np.ndarray, elements: np.ndarray) -> np.ndarray:
    return tetra_edge_lengths(nodes, elements).mean(axis=1)


def distance_to_box(
    points: np.ndarray,
    bounds_min: np.ndarray,
    bounds_max: np.ndarray,
) -> np.ndarray:
    lower = np.maximum(bounds_min - points, 0.0)
    upper = np.maximum(points - bounds_max, 0.0)
    return np.linalg.norm(lower + upper, axis=1)


def assert_monotone_p95_growth(
    testcase,
    distances: np.ndarray,
    sizes: np.ndarray,
    bins: np.ndarray,
    *,
    tolerance_ratio: float,
) -> None:
    previous = None
    populated = 0
    for lo, hi in zip(bins[:-1], bins[1:], strict=True):
        mask = (distances >= lo) & (distances < hi)
        if not np.any(mask):
            continue
        populated += 1
        p95 = float(np.percentile(sizes[mask], 95))
        if previous is not None:
            testcase.assertGreaterEqual(p95 * tolerance_ratio, previous)
        previous = p95
    testcase.assertGreaterEqual(populated, 4)
