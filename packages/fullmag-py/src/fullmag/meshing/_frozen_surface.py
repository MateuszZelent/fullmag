"""Canonical closed-surface triangles for frozen magnetic body geometry."""

from __future__ import annotations

import numpy as np

from ._gmsh_types import MeshData, _MIXED_CELL_LOCAL_FACETS, _mixed_face_adjacency


def _frozen_boundary_triangles(mesh: MeshData) -> tuple[tuple[int, int, int], ...]:
    """Derive an outward-oriented closed triangle surface from volume cells."""
    cell_families = tuple(str(family) for family in mesh.cell_types.tolist())
    if not cell_families:
        raise ValueError("frozen surface STL requires at least one volume cell")
    for ordinal, family in enumerate(cell_families):
        if family not in _MIXED_CELL_LOCAL_FACETS:
            raise ValueError(
                f"frozen surface STL has unsupported cell family {family!r} at cell {ordinal}"
            )

    coordinates = np.asarray(mesh.nodes, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 3:
        raise ValueError("frozen surface STL requires three-dimensional mesh nodes")
    if not np.isfinite(coordinates).all():
        raise ValueError("frozen surface STL requires finite mesh coordinates")

    face_owners = _mixed_face_adjacency(mesh)
    triangles: list[tuple[int, int, int]] = []

    def orientation_score(
        triangle: tuple[int, int, int],
        *,
        owner_center: np.ndarray,
        face_key: tuple[int, ...],
    ) -> float:
        points = coordinates[np.asarray(triangle, dtype=np.int64)]
        normal = np.cross(points[1] - points[0], points[2] - points[0])
        norm = float(np.linalg.norm(normal))
        if not np.isfinite(norm) or norm <= 0.0:
            raise ValueError(
                f"frozen surface STL has a degenerate triangle for face {face_key}"
            )
        score = float(np.dot(normal, owner_center - np.mean(points, axis=0)))
        if not np.isfinite(score) or score == 0.0:
            raise ValueError(
                f"frozen surface STL cannot orient triangle for face {face_key}"
            )
        return score

    for face_key in sorted(face_owners):
        owners = face_owners[face_key]
        if len(owners) > 2:
            raise ValueError(
                f"frozen surface STL found non-manifold face {face_key} "
                f"with {len(owners)} cell owners {owners}"
            )
        if len(set(owners)) != len(owners):
            raise ValueError(
                f"frozen surface STL found a repeated cell owner for face {face_key}: {owners}"
            )
        if len(owners) == 2:
            continue
        if len(owners) != 1:
            raise ValueError(
                f"frozen surface STL expected one or two owners for face {face_key}, "
                f"got {len(owners)}"
            )

        owner = int(owners[0])
        family = cell_families[owner]
        cell_nodes = np.asarray(mesh.cell_node_ids(owner), dtype=np.int64)
        matching_cycles = []
        for local_facet in _MIXED_CELL_LOCAL_FACETS[family]:
            if any(index < 0 or index >= cell_nodes.size for index in local_facet):
                raise ValueError(
                    f"frozen surface STL has an invalid canonical facet for cell {owner} "
                    f"family {family!r}"
                )
            cycle = tuple(int(cell_nodes[index]) for index in local_facet)
            if tuple(sorted(cycle)) == face_key:
                matching_cycles.append(cycle)
        if len(matching_cycles) != 1:
            raise ValueError(
                f"frozen surface STL could not resolve one canonical cycle for face "
                f"{face_key} owned by cell {owner}"
            )

        face_cycle = matching_cycles[0]
        if len(face_cycle) not in (3, 4):
            raise ValueError(
                f"frozen surface STL does not support facet arity {len(face_cycle)} "
                f"for face {face_key}"
            )
        cell_coordinates = coordinates[cell_nodes]
        if not np.isfinite(cell_coordinates).all():
            raise ValueError(
                f"frozen surface STL has non-finite coordinates in owner cell {owner}"
            )
        owner_center = np.mean(cell_coordinates, axis=0)

        face_triangles: tuple[tuple[int, int, int], ...]
        if len(face_cycle) == 3:
            face_triangles = ((face_cycle[0], face_cycle[1], face_cycle[2]),)
        else:
            face_triangles = (
                (face_cycle[0], face_cycle[1], face_cycle[2]),
                (face_cycle[0], face_cycle[2], face_cycle[3]),
            )

        first_score = orientation_score(
            face_triangles[0],
            owner_center=owner_center,
            face_key=face_key,
        )
        if first_score > 0.0:
            face_cycle = (face_cycle[0], *reversed(face_cycle[1:]))
            if len(face_cycle) == 3:
                face_triangles = ((face_cycle[0], face_cycle[1], face_cycle[2]),)
            else:
                face_triangles = (
                    (face_cycle[0], face_cycle[1], face_cycle[2]),
                    (face_cycle[0], face_cycle[2], face_cycle[3]),
                )

        for triangle in face_triangles:
            score = orientation_score(
                triangle,
                owner_center=owner_center,
                face_key=face_key,
            )
            if score >= 0.0:
                raise ValueError(
                    f"frozen surface STL quad or triangle is not consistently outward "
                    f"for face {face_key}"
                )
            triangles.append(triangle)

    if not triangles:
        raise ValueError("frozen surface STL found no external volume faces")

    edge_incidence: dict[tuple[int, int], tuple[int, int]] = {}
    for triangle in triangles:
        for edge_start, edge_end in (
            (triangle[0], triangle[1]),
            (triangle[1], triangle[2]),
            (triangle[2], triangle[0]),
        ):
            edge_vector = coordinates[edge_end] - coordinates[edge_start]
            edge_length = float(np.linalg.norm(edge_vector))
            if edge_start == edge_end or not np.isfinite(edge_length) or edge_length <= 0.0:
                raise ValueError(
                    f"frozen surface STL has a degenerate boundary edge "
                    f"({edge_start}, {edge_end})"
                )
            edge_key = (min(edge_start, edge_end), max(edge_start, edge_end))
            count, orientation_sum = edge_incidence.get(edge_key, (0, 0))
            direction = 1 if edge_start < edge_end else -1
            edge_incidence[edge_key] = (count + 1, orientation_sum + direction)

    for edge_key, (count, orientation_sum) in sorted(edge_incidence.items()):
        if count != 2 or orientation_sum != 0:
            raise ValueError(
                f"frozen surface STL boundary edge {edge_key} must have two "
                f"oppositely directed triangle incidences; got count={count}, "
                f"orientation_sum={orientation_sum}"
            )
    return tuple(triangles)
