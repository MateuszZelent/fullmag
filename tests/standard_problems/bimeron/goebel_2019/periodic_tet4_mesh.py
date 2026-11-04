"""Materialize the conforming, x-periodic Tet4 mesh for the Göbel FEM track."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from tests.standard_problems.bimeron.goebel_2019.common import TRACK_SIZE


AIRBOX_SIZE = (TRACK_SIZE[0], 120e-9, 80.5e-9)
MESH_FILENAME = "goebel_periodic_tet4.mesh.json"

# Each cube uses the body diagonal 000–111. These six positive tetrahedra
# induce the same split on both sides of every shared quadrilateral.
TETS = np.array([
    [0, 4, 6, 7], [0, 5, 4, 7], [0, 6, 2, 7],
    [0, 2, 3, 7], [0, 1, 5, 7], [0, 3, 1, 7],
])


def _symmetric_axis(first: float, sections: list[tuple[float, float]]) -> np.ndarray:
    positive = [np.array([first])]
    start = first
    for end, max_step in sections:
        count = int(np.ceil((end - start) / max_step))
        positive.append(np.linspace(start, end, count + 1)[1:])
        start = end
    half = np.concatenate(positive)
    negative = half[1:] if first == 0 else half
    return np.concatenate((-negative[::-1], half)) * 1e-9


def _plane_triangles(plane: np.ndarray, axis: int, positive: bool) -> np.ndarray:
    a = plane[:-1, :-1].ravel()
    b = plane[1:, :-1].ravel()
    c = plane[:-1, 1:].ravel()
    d = plane[1:, 1:].ravel()
    faces = np.concatenate((np.column_stack((a, b, d)), np.column_stack((a, d, c))))
    if positive != (axis != 1):
        faces = faces[:, [0, 2, 1]]
    return faces


def build_mesh(*, light_airbox: bool = False) -> dict:
    # Fine spacing covers the initial bimeron and its wall. Away from it,
    # x is graded along the track and the air is graded away from the film.
    x = _symmetric_axis(0, [(16, 0.5), (28, 1), (44, 2), (76, 4), (250, 8)])
    # Keep the first 7 nm of air on each open film face. The light profile
    # removes only one outer interval per side, retaining the same box.
    y_outer = [(39, 12), (60, 21)] if light_airbox else [(35, 8), (45, 10), (60, 15)]
    z_outer = [(19.25, 12), (40.25, 21)] if light_airbox else [
        (15.25, 8), (26.25, 11), (40.25, 14)
    ]
    y = _symmetric_axis(0, [(10, 0.5), (20, 1), (21, 1), (23, 2), (27, 4), *y_outer])
    z = _symmetric_axis(0.25, [(1.25, 1), (3.25, 2), (7.25, 4), *z_outer])
    ymin, ymax = np.flatnonzero(np.isclose(np.abs(y), TRACK_SIZE[1] / 2, atol=1e-15))
    zmin, zmax = np.flatnonzero(np.isclose(np.abs(z), TRACK_SIZE[2] / 2, atol=1e-15))
    coordinates = np.stack(np.meshgrid(x, y, z, indexing="ij"), axis=-1)
    magnetic = np.zeros(coordinates.shape[:3], dtype=bool)
    magnetic[:, ymin : ymax + 1, zmin : zmax + 1] = True
    # The FEM periodic certificate requires a contiguous magnetic-node prefix.
    nodes = np.concatenate((coordinates[magnetic], coordinates[~magnetic]))
    ids = np.empty(magnetic.shape, dtype=np.int32)
    count = int(np.count_nonzero(magnetic))
    ids[magnetic] = np.arange(count)
    ids[~magnetic] = np.arange(count, len(nodes))

    corners = np.stack([
        ids[i : i + len(x) - 1, j : j + len(y) - 1, k : k + len(z) - 1].ravel()
        for i in range(2) for j in range(2) for k in range(2)
    ], axis=1)
    elements = corners[:, TETS].reshape(-1, 4)
    magnetic_cells = np.zeros(tuple(n - 1 for n in ids.shape), dtype=np.int32)
    magnetic_cells[:, ymin:ymax, zmin:zmax] = 1
    element_markers = np.repeat(magnetic_cells.ravel(), len(TETS))

    groups = [
        (ids[0], 0, False, 100), (ids[-1], 0, True, 101),
        (ids[:, 0], 1, False, 20), (ids[:, -1], 1, True, 20),
        (ids[:, :, 0], 2, False, 20), (ids[:, :, -1], 2, True, 20),
        (ids[:, ymin, zmin:zmax + 1], 1, False, 10),
        (ids[:, ymax, zmin:zmax + 1], 1, True, 10),
        (ids[:, ymin:ymax + 1, zmin], 2, False, 10),
        (ids[:, ymin:ymax + 1, zmax], 2, True, 10),
    ]
    boundary_faces = []
    boundary_markers = []
    facet_roles = []
    roles = {10: "material_interface", 20: "exterior", 100: "periodic_seam", 101: "periodic_seam"}
    for plane, axis, positive, marker in groups:
        triangles = _plane_triangles(plane, axis, positive)
        boundary_faces.extend(triangles.tolist())
        boundary_markers.extend([marker] * len(triangles))
        facet_roles.extend([roles[marker]] * len(triangles))

    return {
        "mesh_name": (
            "goebel_periodic_tet4_light_airbox" if light_airbox else "goebel_periodic_tet4"
        ),
        "nodes": nodes.tolist(),
        "cells": {
            "types": ["tet4"] * len(elements),
            "offsets": list(range(0, 4 * len(elements) + 1, 4)),
            "nodes": elements.ravel().tolist(),
            "global_ordinals": list(range(len(elements))),
        },
        "element_markers": element_markers.tolist(),
        "facets": {
            "types": ["tri3"] * len(boundary_faces),
            "roles": facet_roles,
            "offsets": list(range(0, 3 * len(boundary_faces) + 1, 3)),
            "nodes": [node for face in boundary_faces for node in face],
            "global_ordinals": list(range(len(boundary_faces))),
        },
        "boundary_markers": boundary_markers,
        "periodic_boundary_pairs": [{
            "pair_id": "x_faces", "marker_a": 100, "marker_b": 101,
            "axis_hint": "x", "translation": [TRACK_SIZE[0], 0, 0], "tolerance": 1e-12,
        }],
        "periodic_node_pairs": [
            {"pair_id": "x_faces", "node_a": a, "node_b": b}
            for a, b in zip(ids[0].ravel().tolist(), ids[-1].ravel().tolist())
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument(
        "--light-airbox",
        action="store_true",
        help="coarsen the outer air beyond the unchanged 7 nm collar around the film",
    )
    args = parser.parse_args()
    mesh = build_mesh(light_airbox=args.light_airbox)
    with args.destination.open("x", encoding="utf-8") as output:
        json.dump(mesh, output, separators=(",", ":"), allow_nan=False)


if __name__ == "__main__":
    main()
