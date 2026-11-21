"""Regenerate the explicitly tagged mesh used by the public FEM M2 fixture.

Run from the repository root with:

    python -B examples/generate_fem_reciprocal_m2_public_mesh.py

The mesh is a center fan over two triangles on each box face: 9 vertices,
12 Tet4 cells, and 12 exterior Tri3 facets. Face markers 101-106 identify
left, right, back, front, bottom, and top respectively. This deterministic
reference asset validates authoring and planner contracts; it is not a
convergence-quality simulation mesh.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from fullmag.meshing.gmsh_bridge import MeshData


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "examples" / "fem_reciprocal_m2_public_mesh.npz"
BODY_SIZE_M = (30.0e-9, 20.0e-9, 4.0e-9)
FACE_TRIANGLES = {
    "left": ((0, 3, 7), (0, 7, 4)),
    "right": ((1, 2, 6), (1, 6, 5)),
    "back": ((0, 1, 5), (0, 5, 4)),
    "front": ((3, 7, 6), (3, 6, 2)),
    "bottom": ((0, 2, 1), (0, 3, 2)),
    "top": ((4, 5, 6), (4, 6, 7)),
}
FACE_MARKERS = {
    "left": 101,
    "right": 102,
    "back": 103,
    "front": 104,
    "bottom": 105,
    "top": 106,
}


def build_mesh_data() -> MeshData:
    """Build the reproducible P1 box mesh in SI coordinates."""
    half_x, half_y, half_z = (size / 2.0 for size in BODY_SIZE_M)
    nodes = np.asarray(
        [
            (-half_x, -half_y, -half_z),
            (half_x, -half_y, -half_z),
            (half_x, half_y, -half_z),
            (-half_x, half_y, -half_z),
            (-half_x, -half_y, half_z),
            (half_x, -half_y, half_z),
            (half_x, half_y, half_z),
            (-half_x, half_y, half_z),
            (0.0, 0.0, 0.0),
        ],
        dtype=np.float64,
    )

    cells: list[tuple[int, int, int, int]] = []
    facets: list[tuple[int, int, int]] = []
    boundary_markers: list[int] = []
    for face_name, triangles in FACE_TRIANGLES.items():
        for triangle in triangles:
            face = list(triangle)
            normal = np.cross(nodes[face[1]] - nodes[face[0]], nodes[face[2]] - nodes[face[0]])
            axis = next(index for index in range(3) if normal[index] != 0.0)
            expected_sign = -1.0 if nodes[face[0], axis] < 0.0 else 1.0
            if normal[axis] * expected_sign < 0.0:
                face[1], face[2] = face[2], face[1]
            facets.append(tuple(face))
            boundary_markers.append(FACE_MARKERS[face_name])

            cell = [8, *face]
            determinant = np.linalg.det(
                np.column_stack(
                    (
                        nodes[cell[1]] - nodes[cell[0]],
                        nodes[cell[2]] - nodes[cell[0]],
                        nodes[cell[3]] - nodes[cell[0]],
                    )
                )
            )
            if determinant < 0.0:
                cell[2], cell[3] = cell[3], cell[2]
            cells.append(tuple(cell))

    return MeshData(
        nodes=nodes,
        cell_types=np.asarray(["tet4"] * len(cells)),
        cell_offsets=np.arange(0, 4 * (len(cells) + 1), 4, dtype=np.int64),
        cell_nodes=np.asarray(cells, dtype=np.int32).reshape(-1),
        element_markers=np.ones(len(cells), dtype=np.uint32),
        facet_types=np.asarray(["tri3"] * len(facets)),
        facet_roles=np.asarray(["exterior"] * len(facets)),
        facet_offsets=np.arange(0, 3 * (len(facets) + 1), 3, dtype=np.int64),
        facet_nodes=np.asarray(facets, dtype=np.int32).reshape(-1),
        boundary_markers=np.asarray(boundary_markers, dtype=np.uint32),
        cell_global_ordinals=np.arange(len(cells), dtype=np.int64),
        facet_global_ordinals=np.arange(len(facets), dtype=np.int64),
        cell_mesh_parts=np.asarray(["magnetic"] * len(cells)),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="output NPZ path (default: the public example's neighboring asset)",
    )
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    build_mesh_data().save(output)
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
